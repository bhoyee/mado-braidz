export class ManagementError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ManagementError';
    this.status = status;
  }
}
// The owner may go ahead after reading what it affects.
export class ManagementConfirm extends ManagementError {
  constructor(title, detail, label = 'Save anyway') {
    super(detail);
    this.confirm = { title, detail, label };
  }
}
