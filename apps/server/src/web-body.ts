import { readBoundedResponseBytes } from "@slide-maker/core";

/** 保留 server 既有錯誤碼介面；位元組上限與串流取消由 core 共用實作。 */
export async function readCappedBytes(
  response: Response,
  limit: number,
  tooLargeCode: string,
): Promise<Uint8Array> {
  return readBoundedResponseBytes(response, limit, () => new Error(tooLargeCode));
}
