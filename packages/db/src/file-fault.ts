export class FileFault extends Error {
  constructor(
    public code: string,
    public status = 404,
  ) {
    super(code);
  }
}
