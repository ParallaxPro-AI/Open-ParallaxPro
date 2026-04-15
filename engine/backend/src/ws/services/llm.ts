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

/**
 * Ask the LLM for a short kebab-case project name derived from a user prompt.
 * Non-streaming, capped by a hard timeout. Returns null on timeout, API error,
 * or empty/unusable output so callers can fall back to a default name.
 */
export async function generateProjectName(prompt: string, timeoutMs: number = 10000): Promise<string | null> {
    const { baseUrl, model, apiKey } = config.ai;
    if (!apiKey || !prompt.trim()) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const systemPrompt =
        'Generate a short (1-4 words) kebab-case project name for a game based on the user\'s description. ' +
        'Reply with ONLY the name — no quotes, no punctuation, no explanation. ' +
        'Use lowercase letters, digits, and hyphens only. ' +
        'Examples: "space-shooter", "zombie-survival", "block-world", "racing-game".';

    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                max_tokens: 24,
                stream: false,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt },
                ],
            }),
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        const raw = data?.choices?.[0]?.message?.content;
        if (typeof raw !== 'string') return null;
        return sanitizeProjectName(raw);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function sanitizeProjectName(raw: string): string | null {
    const cleaned = raw
        .toLowerCase()
        .replace(/["'`]/g, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '');
    return cleaned.length >= 2 ? cleaned : null;
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
