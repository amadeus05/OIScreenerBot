export interface DataCacheService {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttl?: number): void;
    delete(key: string): void;
    clear(): void;
  }
  
  export class MemoryCacheService implements DataCacheService {
    private cache = new Map<string, { value: any; expires: number }>();
  
    get<T>(key: string): T | undefined {
      const item = this.cache.get(key);
      
      if (!item) return undefined;
      
      // Проверяем, не истек ли срок действия
      if (Date.now() > item.expires) {
        this.cache.delete(key);
        return undefined;
      }
      
      return item.value as T;
    }
  
    set<T>(key: string, value: T, ttl: number = 60000): void {
      const expires = Date.now() + ttl;
      this.cache.set(key, { value, expires });
    }
  
    delete(key: string): void {
      this.cache.delete(key);
    }
  
    clear(): void {
      this.cache.clear();
    }
  }