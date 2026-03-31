export class LocalCache {
    private db: IDBDatabase | null = null;
    private static readonly ASSETS_STORE = 'assets';
    private static readonly METADATA_STORE = 'metadata';

    async initialize(dbName: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const request = indexedDB.open(dbName, 1);

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(LocalCache.ASSETS_STORE)) {
                    db.createObjectStore(LocalCache.ASSETS_STORE);
                }
                if (!db.objectStoreNames.contains(LocalCache.METADATA_STORE)) {
                    db.createObjectStore(LocalCache.METADATA_STORE);
                }
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onerror = () => {
                reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
            };
        });
    }

    private getDB(): IDBDatabase {
        if (!this.db) {
            throw new Error('LocalCache has not been initialized.');
        }
        return this.db;
    }

    async get(key: string): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            const tx = this.getDB().transaction(LocalCache.ASSETS_STORE, 'readonly');
            const store = tx.objectStore(LocalCache.ASSETS_STORE);
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error(`Failed to get key "${key}": ${request.error?.message}`));
        });
    }

    async put(key: string, value: any, metadata?: Record<string, unknown>): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const storeNames = [LocalCache.ASSETS_STORE];
            if (metadata) {
                storeNames.push(LocalCache.METADATA_STORE);
            }
            const tx = this.getDB().transaction(storeNames, 'readwrite');

            const assetsStore = tx.objectStore(LocalCache.ASSETS_STORE);
            assetsStore.put(value, key);

            if (metadata) {
                const metaStore = tx.objectStore(LocalCache.METADATA_STORE);
                metaStore.put(metadata, key);
            }

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(new Error(`Failed to put key "${key}": ${tx.error?.message}`));
        });
    }

    async has(key: string): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            const tx = this.getDB().transaction(LocalCache.ASSETS_STORE, 'readonly');
            const store = tx.objectStore(LocalCache.ASSETS_STORE);
            const request = store.count(key);

            request.onsuccess = () => resolve(request.result > 0);
            request.onerror = () => reject(new Error(`Failed to check key "${key}": ${request.error?.message}`));
        });
    }

    async delete(key: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const tx = this.getDB().transaction(
                [LocalCache.ASSETS_STORE, LocalCache.METADATA_STORE],
                'readwrite'
            );
            tx.objectStore(LocalCache.ASSETS_STORE).delete(key);
            tx.objectStore(LocalCache.METADATA_STORE).delete(key);

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(new Error(`Failed to delete key "${key}": ${tx.error?.message}`));
        });
    }

    async clear(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const tx = this.getDB().transaction(
                [LocalCache.ASSETS_STORE, LocalCache.METADATA_STORE],
                'readwrite'
            );
            tx.objectStore(LocalCache.ASSETS_STORE).clear();
            tx.objectStore(LocalCache.METADATA_STORE).clear();

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(new Error(`Failed to clear cache: ${tx.error?.message}`));
        });
    }

    async getMetadata(key: string): Promise<Record<string, unknown> | null> {
        return new Promise<Record<string, unknown> | null>((resolve, reject) => {
            const tx = this.getDB().transaction(LocalCache.METADATA_STORE, 'readonly');
            const store = tx.objectStore(LocalCache.METADATA_STORE);
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => reject(new Error(`Failed to get metadata for key "${key}": ${request.error?.message}`));
        });
    }
}
