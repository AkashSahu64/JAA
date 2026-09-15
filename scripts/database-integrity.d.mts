export function sha256File(path: string): string;
export function assertRegularBackupFile(path: string, label?: string): void;
export function writeBackupManifest(backupPath: string): { manifestPath: string; digest: string };
export function verifyBackupManifest(backupPath: string): string;
