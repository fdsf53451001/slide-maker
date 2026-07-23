/**
 * 給 Cloud Run／GCP Cloud Logging 讀的結構化 log：整行輸出一個 JSON object，
 * 帶 `severity` 欄位（`"INFO"|"WARNING"|"ERROR"`）與自訂欄位供查詢過濾。
 *
 * 純附加工具：不改變任何呼叫端既有的 return 值、拋出的 error 類型或流程，只負責
 * 把資訊印到 stdout/stderr。ERROR 走 `console.error`、WARNING 走 `console.warn`，
 * 其餘走 `console.log`，對齊 Cloud Logging 依 stream 判斷嚴重度的預設行為。
 */

export type LogFields = Record<string, unknown>;

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

function emit(
  severity: "INFO" | "WARNING" | "ERROR",
  event: string,
  fields?: LogFields,
  error?: unknown,
): void {
  const payload: Record<string, unknown> = {
    ...fields,
    severity,
    event,
    timestamp: new Date().toISOString(),
  };
  if (error !== undefined) {
    payload.error = serializeError(error);
  }
  let line: string;
  try {
    line = JSON.stringify(payload);
  } catch {
    line = JSON.stringify({
      severity,
      event,
      timestamp: payload.timestamp,
      logError: "unserializable fields",
    });
  }
  if (severity === "ERROR") {
    console.error(line);
  } else if (severity === "WARNING") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(event: string, fields?: LogFields): void {
  emit("INFO", event, fields);
}

export function logWarn(event: string, fields?: LogFields, error?: unknown): void {
  emit("WARNING", event, fields, error);
}

export function logError(event: string, fields?: LogFields, error?: unknown): void {
  emit("ERROR", event, fields, error);
}
