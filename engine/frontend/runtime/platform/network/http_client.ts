export class HttpClient {
    private baseURL: string = '';
    private authToken: string = '';

    private buildURL(url: string): string {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            return url;
        }
        return this.baseURL + url;
    }

    private buildHeaders(contentType?: string): HeadersInit {
        const headers: Record<string, string> = {};
        if (this.authToken) {
            headers['Authorization'] = `Bearer ${this.authToken}`;
        }
        if (contentType) {
            headers['Content-Type'] = contentType;
        }
        return headers;
    }

    async fetchJSON<T>(url: string): Promise<T> {
        const response = await fetch(this.buildURL(url), {
            method: 'GET',
            headers: this.buildHeaders(),
        });
        if (!response.ok) {
            throw new Error(`HTTP GET ${url} failed with status ${response.status}: ${response.statusText}`);
        }
        return response.json() as Promise<T>;
    }

    async fetchBinary(url: string): Promise<ArrayBuffer> {
        const response = await fetch(this.buildURL(url), {
            method: 'GET',
            headers: this.buildHeaders(),
        });
        if (!response.ok) {
            throw new Error(`HTTP GET ${url} failed with status ${response.status}: ${response.statusText}`);
        }
        return response.arrayBuffer();
    }

    async fetchBlob(url: string): Promise<Blob> {
        const response = await fetch(this.buildURL(url), {
            method: 'GET',
            headers: this.buildHeaders(),
        });
        if (!response.ok) {
            throw new Error(`HTTP GET ${url} failed with status ${response.status}: ${response.statusText}`);
        }
        return response.blob();
    }

    async post<T>(url: string, data: unknown): Promise<T> {
        const response = await fetch(this.buildURL(url), {
            method: 'POST',
            headers: this.buildHeaders('application/json'),
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            throw new Error(`HTTP POST ${url} failed with status ${response.status}: ${response.statusText}`);
        }
        return response.json() as Promise<T>;
    }

    async put<T>(url: string, data: unknown): Promise<T> {
        const response = await fetch(this.buildURL(url), {
            method: 'PUT',
            headers: this.buildHeaders('application/json'),
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            throw new Error(`HTTP PUT ${url} failed with status ${response.status}: ${response.statusText}`);
        }
        return response.json() as Promise<T>;
    }

    async del<T>(url: string): Promise<T> {
        const response = await fetch(this.buildURL(url), {
            method: 'DELETE',
            headers: this.buildHeaders(),
        });
        if (!response.ok) {
            throw new Error(`HTTP DELETE ${url} failed with status ${response.status}: ${response.statusText}`);
        }
        return response.json() as Promise<T>;
    }

    setBaseURL(baseURL: string): void {
        this.baseURL = baseURL;
    }

    setAuthToken(token: string): void {
        this.authToken = token;
    }
}
