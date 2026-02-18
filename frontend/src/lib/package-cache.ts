/**
 * Package Cache — IndexedDB-backed cache for npm package metadata.
 *
 * Foundation for Phase 4C. Provides:
 * - IndexedDB store for frequently used package metadata
 * - Cache-first resolution for package lookups
 * - Background sync for cache invalidation (24h TTL)
 */

const DB_NAME = "vedaa-package-cache";
const DB_VERSION = 1;
const STORE_NAME = "packages";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedPackage {
  name: string;
  version: string;
  cdnUrl: string;
  types?: string;
  cachedAt: number;
  ttlMs: number;
}

export class PackageCache {
  private db: IDBDatabase | null = null;

  async open(): Promise<void> {
    if (this.db) return;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "name" });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async get(packageName: string): Promise<CachedPackage | null> {
    if (!this.db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(packageName);
      request.onsuccess = () => {
        const result = request.result as CachedPackage | undefined;
        if (result && Date.now() - result.cachedAt < result.ttlMs) {
          resolve(result);
        } else {
          resolve(null); // Expired or missing
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async set(pkg: CachedPackage): Promise<void> {
    if (!this.db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put(pkg);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async resolve(packageName: string): Promise<CachedPackage> {
    // Check cache first
    const cached = await this.get(packageName);
    if (cached) return cached;

    // Fetch from CDN registry
    const resp = await fetch(
      `https://data.jsdelivr.com/v1/packages/npm/${encodeURIComponent(packageName)}`
    );
    const data = await resp.json();
    const latest = data.versions?.[0]?.version || "latest";

    const pkg: CachedPackage = {
      name: packageName,
      version: latest,
      cdnUrl: `https://cdn.jsdelivr.net/npm/${packageName}@${latest}`,
      cachedAt: Date.now(),
      ttlMs: DEFAULT_TTL_MS,
    };

    await this.set(pkg);
    return pkg;
  }

  async clear(): Promise<void> {
    if (!this.db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
