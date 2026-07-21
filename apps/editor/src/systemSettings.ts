import { useCallback, useSyncExternalStore } from "react";

export type WebSearchMode = "cached" | "live" | "disabled";

export interface SystemSettings {
  providerId: string;
  textEngine: string;
  webSearchMode: WebSearchMode;
}

const STORAGE_KEY = "slide-maker:system-settings";
const DEFAULTS: SystemSettings = {
  providerId: "mock-image",
  textEngine: "",
  webSearchMode: "cached",
};

type Listener = () => void;
const listeners = new Set<Listener>();

function readStorage(): SystemSettings {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SystemSettings>;
    return {
      providerId:
        typeof parsed.providerId === "string" && parsed.providerId.trim()
          ? parsed.providerId
          : DEFAULTS.providerId,
      textEngine: typeof parsed.textEngine === "string" ? parsed.textEngine : DEFAULTS.textEngine,
      webSearchMode:
        parsed.webSearchMode === "live" ||
        parsed.webSearchMode === "cached" ||
        parsed.webSearchMode === "disabled"
          ? parsed.webSearchMode
          : DEFAULTS.webSearchMode,
    };
  } catch {
    return DEFAULTS;
  }
}

let cache: SystemSettings = readStorage();

function write(next: SystemSettings): void {
  cache = next;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 忽略 quota / 隱私模式寫入失敗；下次讀取會回到 DEFAULTS。
    }
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  cache = readStorage();
  listeners.forEach((listener) => listener());
}

function getSnapshot(): SystemSettings {
  return cache;
}

export function useSystemSettings(): {
  providerId: string;
  textEngine: string;
  webSearchMode: WebSearchMode;
  setProviderId: (value: string) => void;
  setTextEngine: (value: string) => void;
  setWebSearchMode: (value: WebSearchMode) => void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setProviderId = useCallback((value: string) => {
    write({ ...cache, providerId: value });
  }, []);
  const setTextEngine = useCallback((value: string) => {
    write({ ...cache, textEngine: value });
  }, []);
  const setWebSearchMode = useCallback((value: WebSearchMode) => {
    write({ ...cache, webSearchMode: value });
  }, []);
  return {
    providerId: snapshot.providerId,
    textEngine: snapshot.textEngine,
    webSearchMode: snapshot.webSearchMode,
    setProviderId,
    setTextEngine,
    setWebSearchMode,
  };
}

export function resetSystemSettings(): void {
  write(DEFAULTS);
}
