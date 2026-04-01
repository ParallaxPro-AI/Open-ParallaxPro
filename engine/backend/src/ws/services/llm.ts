import { config } from '../../config.js';

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface LLMStreamCallbacks {
    onChunk: (text: string) => void;
    onDone: (fullText: string, usage?: TokenUsage) => void;
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
                stream_options: { include_usage: true },
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
        let usage: TokenUsage | undefined;
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
                    // Extract usage from final streaming event (OpenAI-compatible)
                    if (event.usage) {
                        usage = {
                            promptTokens: event.usage.prompt_tokens ?? 0,
                            completionTokens: event.usage.completion_tokens ?? 0,
                            totalTokens: event.usage.total_tokens ?? 0,
                        };
                    }
                } catch {}
            }
        }

        callbacks.onDone(fullText, usage);
    } catch (e: any) {
        if (e.name === 'AbortError') return;
        callbacks.onError(e.message ?? 'LLM request failed');
    }
}
