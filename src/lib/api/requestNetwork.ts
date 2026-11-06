export interface RequestIp {
  ip: string;
  port?: number | null;
  kind: 'remote' | 'upstream' | 'target';
  source: string;
}
