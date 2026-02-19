import * as vscode from 'vscode';
import type { ConnectionManager } from './connection';
import { Logging } from './logging';
import { setActiveChatStream } from './chatTools';

const SYSTEM_PROMPT = `You are an SSH assistant for the SSH FS Plus VS Code extension. You help users work with remote files and servers connected via SSH.

You have access to powerful tools for interacting with the remote SSH server:
- sshfs_run_command: Execute shell commands on the remote server
- sshfs_find_files: Find files and folders by name or pattern
- sshfs_list_directory: List directory contents
- sshfs_directory_tree: Get a hierarchical directory tree
- sshfs_read_file: Read file contents with line numbers
- sshfs_edit_file: Edit files using find-and-replace
- sshfs_search_text: Search for text patterns in files using grep

When editing files, always read the file first to understand its current content, then make precise edits with enough context to ensure unique matches. Describe what changes you are making and why.

The workspace filesystem is remote (SSH/SFTP). Always use the sshfs_* tools — standard VS Code tools will fail or be extremely slow on this workspace.`;

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
        const model = request.model;

        // Gather our SSH tools
        const tools = vscode.lm.tools.filter(t => t.name.startsWith('sshfs_'));

        if (tools.length === 0) {
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

        // Prepare tool definitions for the LLM
        const options: vscode.LanguageModelChatRequestOptions = {
            tools: tools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema as Record<string, unknown>,
            })),
        };

        // Set the active chat stream so SSHEditFileTool can use textEdit()
        setActiveChatStream(stream);

        try {
            await runToolLoop(model, messages, options, request, stream, token);
        } finally {
            setActiveChatStream(undefined);
        }

        return {};
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
 */
async function runToolLoop(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    options: vscode.LanguageModelChatRequestOptions,
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {
    const MAX_ROUNDS = 15;

    for (let round = 0; round < MAX_ROUNDS; round++) {
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
                const result = await vscode.lm.invokeTool(toolCall.name, {
                    input: toolCall.input,
                    toolInvocationToken: request.toolInvocationToken,
                } as vscode.LanguageModelToolInvocationOptions<object>, token);

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
