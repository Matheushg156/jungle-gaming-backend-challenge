export interface ProviderPrincipal {
  readonly subject: string;
  readonly operator: boolean;
  readonly providerId?: string;
}

export abstract class AccessTokenVerifier {
  abstract verify(token: string): Promise<ProviderPrincipal>;
}
