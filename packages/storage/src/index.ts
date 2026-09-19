// @taw/storage — BlobStore 接口与本地内容寻址实现。随 M1 充实。
export interface PutResult {
  teamId: string;
  digest: string;
  size: number;
}

export interface BlobStore {
  put(teamId: string, content: Buffer): Promise<PutResult>;
  get(teamId: string, digest: string): Promise<Buffer>;
  exists(teamId: string, digest: string): Promise<boolean>;
}

export const BLOB_DIGEST_RE = /^[0-9a-f]{64}$/;
