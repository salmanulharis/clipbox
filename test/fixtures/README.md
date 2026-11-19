Fixture for backup interoperability tests.

- interop-backup.cbx: encrypted private-notes backup in the ClipBox .cbx format
  ("CBX1" | uint32 BE iterations | 16-byte salt | 12-byte IV | AES-256-GCM ciphertext+tag),
  PBKDF2-SHA256 with 2000 iterations, passphrase `fixture-passphrase`. Contains one note titled "Interop note".
  Imported by the web e2e tests to prove backups made elsewhere in this format can be restored.
