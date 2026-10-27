export class SecretRedactor {
  private readonly secrets = new Set<string>();

  add(secret: string | undefined): void {
    if (!secret) return;
    this.secrets.add(secret);
    this.secrets.add(JSON.stringify(secret).slice(1, -1));
    if (secret.isWellFormed()) this.secrets.add(encodeURIComponent(secret));
  }

  text(value: string): string {
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) value = value.split(secret).join("***redacted***");
    return value;
  }

  value(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((child) => this.value(child));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [this.text(key), this.value(child)]));
    return value;
  }
}
