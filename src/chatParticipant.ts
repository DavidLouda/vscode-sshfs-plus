import * as vscode from 'vscode';
import type { ConnectionManager } from './connection';
import { Logging } from './logging';
import { setActiveChatStream } from './chatTools';

const SYSTEM_PROMPT = `You are an SSH assistant. The workspace is remote (SSH/SFTP). Use ONLY sshfs_* tools — built-in VS Code tools fail on this workspace.

Tools:
- sshfs_search_text: grep text in files. Use BEFORE reading large files to find relevant lines.
- sshfs_read_file: read file with line numbers. Use startLine/endLine for specific ranges.
- sshfs_edit_file: edit file. Modes: (1) oldString+newString, (2) edits[] array, (3) insertAfterLine+newString.
- sshfs_create_file: create new file (fails if exists).
- sshfs_find_files: find files/dirs by name or glob.
- sshfs_list_directory: list directory contents.
- sshfs_directory_tree: project structure tree.
- sshfs_run_command: execute shell commands. NOT for grep/search/read/edit — use dedicated tools above.

Rules:
1. For large files: sshfs_search_text first → get line numbers → sshfs_read_file with startLine/endLine. Never read entire files sequentially.
2. Before editing: read the relevant section first.
3. Multiple edits in one file: use edits[] array in single sshfs_edit_file call.
4. Never use sshfs_run_command for grep — always sshfs_search_text.`;

/**
 * Registers a Chat Participant `@sshfs` that provides an interactive chat
 * experience for SSH file system operations. When the user types `@sshfs`
 * in the chat, this participant handles the request using the SSH tools
 * and can propose inline edits via `stream.textEdit()` (proposed API).
 */
export function registerChatParticipant(
    connectionManager: ConnectionManager,
    context: vscode.ExtensionContext
): void {
    if (typeof vscode.chat?.createChatParticipant !== 'function') {
        Logging.debug`Chat Participant API not available (vscode.chat.createChatParticipant)`;
        return;
    }

    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {
        // o1/o3 models don't support tool calling — fall back to gpt-4o
        let model = request.model;
        if (model.vendor === 'copilot' && (model.family.startsWith('o1') || model.family.startsWith('o3'))) {
            const fallbackModels = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
            if (fallbackModels.length > 0) {
                Logging.info`ChatParticipant: ${model.family} does not support tools, falling back to gpt-4o`;
                model = fallbackModels[0];
            }
        }

        // Gather our SSH tools
        const allTools = vscode.lm.tools.filter(t => t.name.startsWith('sshfs_'));

        if (allTools.length === 0) {
            stream.markdown('No SSH FS tools available. Make sure you have an active SSH connection.');
            return {};
        }

        // Build initial messages
        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
        ];

        // Add conversation history
        for (const turn of chatContext.history) {
            if (turn instanceof vscode.ChatRequestTurn) {
                messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
            } else if (turn instanceof vscode.ChatResponseTurn) {
                const responseText = turn.response
                    .filter((r): r is vscode.ChatResponseMarkdownPart => r instanceof vscode.ChatResponseMarkdownPart)
                    .map(r => r.value.value)
                    .join('');
                if (responseText) {
                    messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
                }
            }
        }

        // Add current user request
        messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

        // Handle explicit tool references (#sshCommand, #sshReadFile, etc.)
        // When user references a tool with #, force the model to call it
        const toolReferences = [...(request.toolReferences ?? [])];

        // Prepare tool definitions for the LLM
        const options: vscode.LanguageModelChatRequestOptions = {
            justification: 'To assist with SSH remote file operations via @sshfs',
            tools: allTools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema as Record<string, unknown>,
            })),
        };

        // Track tool call metadata for prompt history on future requests
        const toolCallRounds: { response: string; toolCalls: vscode.LanguageModelToolCallPart[] }[] = [];
        const toolCallResults: Record<string, vscode.LanguageModelToolResult> = {};

        // Set the active chat stream so SSHEditFileTool can use textEdit()
        setActiveChatStream(stream);

        try {
            await runToolLoop(model, messages, options, allTools, toolReferences, request, stream, token, toolCallRounds, toolCallResults);
        } finally {
            setActiveChatStream(undefined);
        }

        return {
            metadata: { toolCallsMetadata: { toolCallRounds, toolCallResults } },
        };
    };

    try {
        const participant = vscode.chat.createChatParticipant('vscode-sshfs.sshfs', handler);
        participant.iconPath = new vscode.ThemeIcon('remote');
        context.subscriptions.push(participant);
        Logging.info`Registered Chat Participant: @sshfs`;
    } catch (e) {
        Logging.warning`Failed to register Chat Participant: ${e}`;
    }
}

/**
 * Runs the LLM tool-calling loop: sends messages to the model, processes
 * tool calls, invokes tools, and streams the response back to the chat.
 * Loops until the model stops requesting tool calls or MAX_ROUNDS is reached.
 * 
 * Supports explicit tool references: when user uses #toolName, that tool
 * is called with toolMode=Required on the first round, then normal Auto mode.
 */
async function runToolLoop(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    options: vscode.LanguageModelChatRequestOptions,
    allTools: readonly vscode.LanguageModelToolInformation[],
    toolReferences: vscode.ChatLanguageModelToolReference[],
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    toolCallRounds: { response: string; toolCalls: vscode.LanguageModelToolCallPart[] }[],
    toolCallResults: Record<string, vscode.LanguageModelToolResult>,
): Promise<void> {
    const MAX_ROUNDS = 15;

    for (let round = 0; round < MAX_ROUNDS; round++) {
        // If user explicitly referenced a tool via #toolName, force it on this round
        const requestedTool = toolReferences.shift();
        if (requestedTool) {
            options.toolMode = vscode.LanguageModelChatToolMode.Required;
            options.tools = allTools
                .filter(t => t.name === requestedTool.name)
                .map(t => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema as Record<string, unknown>,
                }));
        } else {
            options.toolMode = undefined;
            options.tools = allTools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema as Record<string, unknown>,
            }));
        }

        const response = await model.sendRequest(messages, options, token);

        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        let responseText = '';

        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                stream.markdown(part.value);
                responseText += part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }
        }

        // No more tool calls — the model is done
        if (toolCalls.length === 0) break;

        // Process each tool call
        const toolResultParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart)[] = [];
        const toolCallParts: vscode.LanguageModelToolCallPart[] = [];

        for (const toolCall of toolCalls) {
            stream.progress(`Running ${toolCall.name}...`);

            try {
                let result = await vscode.lm.invokeTool(toolCall.name, {
                    input: toolCall.input,
                    toolInvocationToken: request.toolInvocationToken,
                } as vscode.LanguageModelToolInvocationOptions<object>, token);

                // Auto-retry for sshfs_edit_file: if oldString not found, re-read the file and retry once
                if (toolCall.name === 'sshfs_edit_file') {
                    const resultText = result.content
                        .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
                        .map(p => p.value).join('');

                    if (resultText.includes('oldString was not found') || resultText.includes('oldString not found')) {
                        const input = toolCall.input as { path?: string; connectionName?: string };
                        if (input.path) {
                            Logging.info`ChatParticipant auto-retry: re-reading ${input.path} before retrying edit`;
                            stream.progress(`Edit failed — re-reading file and retrying...`);

                            // Read the file to refresh Copilot's context
                            try {
                                const readResult = await vscode.lm.invokeTool('sshfs_read_file', {
                                    input: { path: input.path, connectionName: input.connectionName },
                                    toolInvocationToken: request.toolInvocationToken,
                                } as vscode.LanguageModelToolInvocationOptions<object>, token);

                                // Retry the edit — the model will see the fresh content in the next round
                                // We pass the read result as context back to the model
                                const readText = readResult.content
                                    .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
                                    .map(p => p.value).join('');

                                result = new vscode.LanguageModelToolResult([
                                    new vscode.LanguageModelTextPart(
                                        `${resultText}\n\nAuto-retry: The file was re-read. Here is the current content:\n${readText}\n\nPlease retry the edit with the correct oldString from the content above.`
                                    )
                                ]);
                            } catch {
                                // Read failed — keep original error
                            }
                        }
                    }
                }

                toolCallParts.push(new vscode.LanguageModelToolCallPart(
                    toolCall.callId, toolCall.name, toolCall.input
                ));
                toolResultParts.push(new vscode.LanguageModelToolResultPart(
                    toolCall.callId,
                    result.content
                ));
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                Logging.warning`ChatParticipant tool ${toolCall.name} error: ${errorMsg}`;

                toolCallParts.push(new vscode.LanguageModelToolCallPart(
                    toolCall.callId, toolCall.name, toolCall.input
                ));
                toolResultParts.push(new vscode.LanguageModelToolResultPart(
                    toolCall.callId,
                    [new vscode.LanguageModelTextPart(`Error: ${errorMsg}`)]
                ));
            }
        }

        // Track tool call round for metadata
        toolCallRounds.push({ response: responseText, toolCalls });

        // Add assistant turn (with tool calls) + user turn (with tool results)
        if (responseText) {
            // Assistant produced both text and tool calls
            const assistantContent: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [
                new vscode.LanguageModelTextPart(responseText),
                ...toolCallParts,
            ];
            messages.push(vscode.LanguageModelChatMessage.Assistant(assistantContent));
        } else {
            messages.push(vscode.LanguageModelChatMessage.Assistant(toolCallParts));
        }

        messages.push(vscode.LanguageModelChatMessage.User(
            toolResultParts as vscode.LanguageModelToolResultPart[]
        ));
    }
}
