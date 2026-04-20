// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// App Service "Easy Auth" middleware
// ---------------------------------------------------------------------------
// When Easy Auth is enabled in passive mode, App Service forwards an
// X-MS-CLIENT-PRINCIPAL header (base64-encoded JSON) on every authenticated
// request. We decode it here and gate the dashboard API on a real Entra ID
// session. No JWT validation is needed — App Service has already done it.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from 'express';

export interface EasyAuthPrincipal {
  /** The user's object id (Entra ID `oid`). */
  oid?: string;
  /** Preferred username / email (UPN). */
  email?: string;
  /** Display name. */
  name?: string;
  /** Tenant id. */
  tenantId?: string;
  /** Raw claim list from Easy Auth. */
  claims: Array<{ typ: string; val: string }>;
}

interface RawPrincipal {
  auth_typ?: string;
  name_typ?: string;
  role_typ?: string;
  claims?: Array<{ typ: string; val: string }>;
}

/** Decode the X-MS-CLIENT-PRINCIPAL header into a typed principal. */
export function decodePrincipal(headerValue: string | undefined): EasyAuthPrincipal | null {
  if (!headerValue || typeof headerValue !== 'string') return null;
  try {
    const json = Buffer.from(headerValue, 'base64').toString('utf8');
    const raw = JSON.parse(json) as RawPrincipal;
    const claims = raw.claims ?? [];
    const find = (...types: string[]): string | undefined => {
      for (const c of claims) if (types.includes(c.typ)) return c.val;
      return undefined;
    };
    return {
      oid: find('http://schemas.microsoft.com/identity/claims/objectidentifier', 'oid'),
      email: find(
        'preferred_username',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
        'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
        'email',
      ),
      name: find('name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'),
      tenantId: find('http://schemas.microsoft.com/identity/claims/tenantid', 'tid'),
      claims,
    };
  } catch {
    return null;
  }
}

/**
 * Express middleware: 401 unless an Easy Auth principal is present and the
 * tenant matches the configured `MicrosoftAppTenantId`. Attaches the principal
 * to `req.easyAuthPrincipal` for downstream handlers.
 */
export function requireEasyAuth(
  req: Request & { easyAuthPrincipal?: EasyAuthPrincipal },
  res: Response,
  next: NextFunction,
): void {
  const header = req.header('X-MS-CLIENT-PRINCIPAL');
  const principal = decodePrincipal(header);
  if (!principal || !principal.oid) {
    res.status(401).json({
      error: 'Unauthorized',
      loginUrl: '/.auth/login/aad?post_login_redirect_uri=/dashboard/',
    });
    return;
  }
  const expectedTenant = process.env.MicrosoftAppTenantId || process.env.MICROSOFT_APP_TENANTID;
  if (expectedTenant && principal.tenantId && principal.tenantId !== expectedTenant) {
    res.status(403).json({ error: 'Forbidden — tenant mismatch' });
    return;
  }
  req.easyAuthPrincipal = principal;
  next();
}
