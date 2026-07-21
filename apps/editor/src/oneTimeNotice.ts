import { useCallback, useState } from "react";

/**
 * 「說明一次就好」的提示：使用者按過「知道了」之後就不再出現。
 *
 * 用 localStorage 而不是專案欄位：這是使用者對某個行為的認知，不屬於任何一份簡報，
 * 而且換了瀏覽器重新看到一次也無妨。寫入失敗（隱私模式、quota）只代表下次會再提示
 * 一次，不影響任何流程，所以整段吞掉例外。
 */
const PREFIX = "slide-maker:notice:";

function acknowledged(key: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(`${PREFIX}${key}`) === "1";
  } catch {
    return false;
  }
}

export function useOneTimeNotice(key: string): { pending: boolean; acknowledge: () => void } {
  const [seen, setSeen] = useState(() => acknowledged(key));
  const acknowledge = useCallback(() => {
    setSeen(true);
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(`${PREFIX}${key}`, "1");
    } catch {
      // 忽略寫入失敗：最多下次再提示一次。
    }
  }, [key]);
  return { pending: !seen, acknowledge };
}
