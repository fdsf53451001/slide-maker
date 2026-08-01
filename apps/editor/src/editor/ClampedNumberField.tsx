import { useEffect, useState } from "react";

/**
 * 受控、但延後送出的整數輸入框。
 *
 * 每個 keystroke 就送出去的話，「30 → 45」這種兩位數修改永遠打不進去：伺服器先收到的是
 * `4`，違反 `min` 被擋成 400，受控 input 當場被打回舊值——12–120 這種區間裡每個值的
 * 首位數字都小於下界，必中。清空欄位同理（`Number("") === 0`）。
 * 因此打字期間只動本地 draft，失焦或按 Enter 才夾進合法區間送出；空字串與非數字一律還原。
 */
export function ClampedNumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // 值從外部變動（切換專案、送出後伺服器夾過的結果）時同步回 draft。
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  const commit = () => {
    const parsed = Number(draft.trim());
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit();
        }}
      />
    </label>
  );
}
