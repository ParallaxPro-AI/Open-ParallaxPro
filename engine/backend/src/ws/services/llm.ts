import { config } from '../../config.js';

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LLMStreamCallbacks {
    onChunk: (text: string) => void;
    onDone: (fullText: string) => void;
    onError: (error: string) => void;
}

export async function callLLMStream(
    messages: LLMMessage[],
    callbacks: LLMStreamCallbacks,
    abortSignal?: AbortSignal,
): Promise<void> {
    const { baseUrl, model, apiKey, maxTokens } = config.ai;

    if (!apiKey) {
        callbacks.onError('AI_API_KEY not configured. Set it in your .env file.');
        return;
    }

    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                stream: true,
                messages: messages.map(m => ({ role: m.role, content: m.content })),
            }),
            signal: abortSignal,
        });

        if (!res.ok) {
            const err = await res.text();
            callbacks.onError(`LLM API error ${res.status}: ${err}`);
            return;
        }

        let fullText = '';
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const event = JSON.parse(data);
                    const content = event.choices?.[0]?.delta?.content;
                    if (content) {
                        fullText += content;
                        callbacks.onChunk(content);
                    }
                } catch {}
            }
        }

        callbacks.onDone(fullText);
    } catch (e: any) {
        if (e.name === 'AbortError') return;
        callbacks.onError(e.message ?? 'LLM request failed');
    }
}
