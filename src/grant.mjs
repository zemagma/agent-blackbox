// Spending grants for GrantWallet (contracts/GrantWallet.sol), following the Claus
// signal-grant pattern: owner-signed (EIP-712), finite, expiring, revocable on-chain.
import { readFileSync } from 'node:fs';
import { hashTypedData, getAddress } from 'viem';

export const artifact = JSON.parse(readFileSync(new URL('../contracts/build/GrantWallet.json', import.meta.url), 'utf8'));
export const abi = artifact.abi;

export const GRANT_TYPES = {
  SpendGrant: [
    { name: 'agent', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'maxPerPayment', type: 'uint256' },
    { name: 'maxPerDay', type: 'uint256' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export const grantDomain = ({ chainId, wallet }) =>
  ({ name: 'Agent Blackbox GrantWallet', version: '1', chainId: BigInt(chainId), verifyingContract: getAddress(wallet) });

/** Normalises a grant (bigints, checksummed addresses). */
export function makeGrant({ agent, recipient, maxPerPayment, maxPerDay, expiresAt, nonce = 0n }) {
  const g = { agent: getAddress(agent), recipient: getAddress(recipient), maxPerPayment: BigInt(maxPerPayment),
    maxPerDay: BigInt(maxPerDay), expiresAt: BigInt(expiresAt), nonce: BigInt(nonce) };
  if (g.maxPerPayment <= 0n || g.maxPerDay < g.maxPerPayment) throw new Error('grant limits must be positive, daily at least per payment');
  return g;
}

/** The grant's id: the EIP-712 digest the owner signs (same as GrantWallet.grantId). */
export const grantId = ({ chainId, wallet, grant }) =>
  hashTypedData({ domain: grantDomain({ chainId, wallet }), types: GRANT_TYPES, primaryType: 'SpendGrant', message: grant });

/** The owner signs the grant with a viem account. */
export const signGrant = (account, { chainId, wallet, grant }) =>
  account.signTypedData({ domain: grantDomain({ chainId, wallet }), types: GRANT_TYPES, primaryType: 'SpendGrant', message: grant });

/** JSON-safe copy of a grant (bigints as decimal strings) for state and the log. */
export const grantToJson = (g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
export const grantFromJson = (j) => makeGrant(j);
