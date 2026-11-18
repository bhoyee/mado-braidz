export class ManagementError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ManagementError';
    this.status = status;
  }
}
