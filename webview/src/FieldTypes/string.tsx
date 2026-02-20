import * as React from 'react';
import { FieldBase } from './base';

interface ExtraProps {
    placeholder?: string;
    type?: string;
}

export class FieldString extends FieldBase<string | undefined, ExtraProps> {
    public getInitialSubState({ value }: FieldString['props']): FieldString['state'] {
        value = value || undefined;
        return { oldValue: value, newValue: value };
    }
    public renderInput() {
        const { placeholder, type } = this.props;
        return <input value={this.state.newValue || ''} onChange={this.onChangeEvent} placeholder={placeholder} type={type || 'text'} />;
    }
    public onChangeEvent = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.onChange(event.target.value || undefined);
    }
}