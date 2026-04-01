import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, '../../../chat_logs');

fs.mkdirSync(LOGS_DIR, { recursive: true });

export function appendToLog(projectId: string, sessionId: string, entry: {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: string;
}): void {
    const filename = `${projectId}_${sessionId}.jsonl`;
    const filePath = path.join(LOGS_DIR, filename);
    const line = JSON.stringify({
        ...entry,
        timestamp: entry.timestamp || new Date().toISOString(),
    });

    try {
        fs.appendFileSync(filePath, line + '\n');
    } catch {
        // Don't crash the server if logging fails
    }
}
