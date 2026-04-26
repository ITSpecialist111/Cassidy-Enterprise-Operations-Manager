// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// CTE (Custom Teams Endpoint) token issuer.
//
// Flow:
//   1. Use the long-lived refresh_token (provisioned interactively as Cassidy)
//      to mint a fresh AAD access token for the ACS Teams.ManageCalls /
//      Teams.ManageChats scopes.
//   2. POST that AAD token to the ACS Identity REST API
//      (/teamsUser/:exchangeAccessToken) to receive an ACS Teams-user token.
//   3. Return the ACS token to the dashboard, which uses
//      @azure/communication-calling's createTeamsCallAgent to place a 1:1 call
//      to a target Teams user via federation — no Teams Phone licence required.
//
// Tokens are cached in-process and refreshed when within 5 minutes of expiry.

import { createHash, createHmac } from 'crypto';
import { logger } from '../logger';

interface AadTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

interface AcsTeamsUserToken {
  token: string;
  expiresOn: string;
  expiresAt: number; // epoch ms
}

let aadCache: AadTokenSet | null = null;
let acsCache: AcsTeamsUserToken | null = null;

const SKEW_MS = 5 * 60 * 1000;

/**
 * @returns true if the env vars required to issue CTE tokens are present.
 */
export function isCteConfigured(): boolean {
  return Boolean(
    process.env.CTE_TENANT_ID &&
    process.env.CTE_CLIENT_ID &&
    process.env.CTE_USER_OBJECT_ID &&
    process.env.CTE_REFRESH_TOKEN &&
    process.env.ACS_CONNECTION_STRING,
  );
}

function parseAcsConnectionString(cs: string): { endpoint: string; key: string } {
  const parts = Object.fromEntries(
    cs.split(';').filter(Boolean).map(p => {
      const i = p.indexOf('=');
      return [p.slice(0, i), p.slice(i + 1)];
    }),
  );
  const endpoint = (parts['endpoint'] || '').replace(/\/+$/, '');
  const key = parts['accesskey'] || '';
  if (!endpoint || !key) throw new Error('ACS_CONNECTION_STRING missing endpoint/accesskey');
  return { endpoint, key };
}

/** Refresh the Cassidy AAD token using the stored refresh_token. */
async function refreshAadToken(): Promise<AadTokenSet> {
  const tenant = process.env.CTE_TENANT_ID!;
  const clientId = process.env.CTE_CLIENT_ID!;
  const refreshToken = process.env.CTE_REFRESH_TOKEN!;
  const scope = [
    'https://auth.msft.communication.azure.com/Teams.ManageCalls',
    'https://auth.msft.communication.azure.com/Teams.ManageChats',
    'offline_access',
  ].join(' ');

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope,
  });

  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`AAD refresh failed: ${res.status} ${txt.slice(0, 400)}`);
  }
  const json = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || refreshToken,
    expiresAt: Date.now() + (json.expires_in * 1000),
  };
}

/** HMAC-sign and POST to ACS /teamsUser/:exchangeAccessToken. */
async function exchangeForAcsToken(aad: string): Promise<AcsTeamsUserToken> {
  const cs = process.env.ACS_CONNECTION_STRING!;
  const clientId = process.env.CTE_CLIENT_ID!;
  const userObjectId = process.env.CTE_USER_OBJECT_ID!;
  const { endpoint, key } = parseAcsConnectionString(cs);

  const apiVersion = '2023-10-01';
  const reqPath = `/teamsUser/:exchangeAccessToken?api-version=${apiVersion}`;
  const url = `${endpoint}${reqPath}`;
  const bodyJson = JSON.stringify({ token: aad, appId: clientId, userId: userObjectId });
  const date = new Date().toUTCString();
  const hostHeader = new URL(endpoint).host;
  const contentHash = createHash('sha256').update(bodyJson, 'utf8').digest('base64');
  const stringToSign = `POST\n${reqPath}\n${date};${hostHeader};${contentHash}`;
  const sig = createHmac('sha256', Buffer.from(key, 'base64')).update(stringToSign, 'utf8').digest('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-ms-date': date,
      'x-ms-content-sha256': contentHash,
      Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${sig}`,
      'Content-Type': 'application/json',
    },
    body: bodyJson,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ACS exchange failed: ${res.status} ${txt.slice(0, 400)}`);
  }
  const json = await res.json() as { token: string; expiresOn: string };
  return {
    token: json.token,
    expiresOn: json.expiresOn,
    expiresAt: Date.parse(json.expiresOn),
  };
}

/**
 * Issue (or return cached) ACS Teams-user token for the Cassidy CTE identity.
 * Token is cached until ~5 min before expiry.
 */
export async function getCteAcsToken(): Promise<{
  token: string;
  expiresOn: string;
  userObjectId: string;
}> {
  if (!isCteConfigured()) {
    throw new Error('CTE not configured (missing CTE_* or ACS_CONNECTION_STRING env vars)');
  }
  const now = Date.now();

  if (!aadCache || aadCache.expiresAt - now < SKEW_MS) {
    aadCache = await refreshAadToken();
    acsCache = null;
    logger.info('CTE AAD token refreshed', { module: 'voice.cte', expiresIn: Math.round((aadCache.expiresAt - now) / 1000) });
  }

  if (!acsCache || acsCache.expiresAt - now < SKEW_MS) {
    acsCache = await exchangeForAcsToken(aadCache.accessToken);
    logger.info('CTE ACS token minted', { module: 'voice.cte', expiresOn: acsCache.expiresOn });
  }

  return {
    token: acsCache.token,
    expiresOn: acsCache.expiresOn,
    userObjectId: process.env.CTE_USER_OBJECT_ID!,
  };
}
