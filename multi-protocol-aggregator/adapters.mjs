// One adapter per protocol, all with the same shape, so the aggregator can query, route and prepare across them:
//   venues(asset) → [{ id, label, protocol, asset, apy, liquidity?, exit }]
//   positions(user) → [{ venue, asset, amount }]
//   deposit(user, venue, raw) / withdraw(user, venue, raw) → [{ step, to, data }]  (unsigned)
import { encodeFunctionData, erc20Abi, getAddress, parseAbi } from "viem";
import { read } from "../lib/pharos.mjs";
import { MORPHO, VAULT_ABI, morphoMarket, vault } from "../lib/protocols.mjs";

const MORPHO_W = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; address oracle; address irm; uint256 lltv; }",
  "function supply(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
  "function withdraw(MarketParams marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
]);
const VAULT_W = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function requestRedeem(uint256 shares, address controller, address owner) returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
]);
// One at a time: Chain MCP allows 120 requests a minute.
const seq = async (xs, f) => { const out = []; for (const x of xs) out.push(await f(x)); return out; };
const approve = (token, spender, raw, label) => ({ step: `approve ${label}`, to: getAddress(token), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(spender), raw] }) });

export function morphoAdapter(reg, ctx) {
  let cache;
  const load = async () => (cache ??= await seq(reg.morphoMarkets, (id) => morphoMarket(ctx.mcp, id, ctx.block, { now: ctx.now, user: ctx.user })));
  return {
    name: "Morpho Blue",
    async venues(asset) {
      return (await load()).filter((m) => m.loan === asset && m.supplied > 0).map((m) => ({
        id: m.id, label: m.label, protocol: "Morpho Blue", asset, apy: m.supplyApy, liquidity: m.liquidity, exit: "instant up to the market's liquidity",
        exitVerified: true, raw: m, source: `${MORPHO} market(${m.id.slice(0, 10)}…) + IRM at block ${ctx.block}`,
      }));
    },
    async positions() {
      return (await load()).filter((m) => m.position?.supplied > 0).map((m) => ({ venue: m.id, label: m.label, protocol: "Morpho Blue", asset: m.loan, amount: m.position.supplied, apy: m.supplyApy }));
    },
    deposit(user, v, raw) {
      return [approve(v.raw.loanAddress, MORPHO, raw, `${v.asset} to Morpho`), { step: `supply to ${v.label}`, to: MORPHO, data: encodeFunctionData({ abi: MORPHO_W, functionName: "supply", args: [v.raw.params, raw, 0n, user, "0x"] }) }];
    },
    async withdraw(user, v, raw) {
      return [{ step: `withdraw from ${v.label}`, to: MORPHO, data: encodeFunctionData({ abi: MORPHO_W, functionName: "withdraw", args: [v.raw.params, raw, 0n, user, user] }) }];
    },
  };
}

export function vaultAdapter(reg, ctx) {
  let cache;
  const load = async () => (cache ??= await seq(reg.vaults, (v) => vault(ctx.mcp, v, ctx.block, { days: 7, user: ctx.user })));
  return {
    name: "Vaults (ERC-4626 / ERC-7575)",
    async venues(asset) {
      return (await load()).filter((x) => x.asset === asset).map((x) => ({
        id: x.address, label: x.label, protocol: "Vaults", asset, apy: x.apy ?? null, exit: x.redemptionNote, exitVerified: x.exitVerified,
        exitFeePct: x.exitFeePct ?? 0, entryFeePct: x.entryFeePct ?? 0, raw: x, source: `${x.address}.convertToAssets at blocks ${ctx.block - 7 * 86400} and ${ctx.block}`,
      }));
    },
    async positions() {
      return (await load()).filter((x) => x.position?.assets > 0).map((x) => ({ venue: x.address, label: x.label, protocol: "Vaults", asset: x.asset, amount: x.position.assets, apy: x.apy ?? null }));
    },
    deposit(user, v, raw) {
      return [approve(v.raw.assetAddress, v.id, raw, `${v.asset} to ${v.label}`), { step: `deposit into ${v.label}`, to: getAddress(v.id), data: encodeFunctionData({ abi: VAULT_W, functionName: "deposit", args: [raw, user] }) }];
    },
    async withdraw(user, v, raw) {
      if (v.raw.redemptionMode === "async") {
        // ERC-7540: exits are a request; the assets arrive when the vault settles it.
        const shares = await read(ctx.mcp, v.id, VAULT_ABI, "convertToShares", [raw], ctx.block);
        return [{ step: `requestRedeem from ${v.label} (asynchronous: the ${v.asset} arrives when the vault settles the request)`, to: getAddress(v.id), data: encodeFunctionData({ abi: VAULT_W, functionName: "requestRedeem", args: [shares, user, user] }) }];
      }
      return [{ step: `withdraw from ${v.label}`, to: getAddress(v.id), data: encodeFunctionData({ abi: VAULT_W, functionName: "withdraw", args: [raw, user, user] }) }];
    },
    async maxWithdraw(user, v) {
      return read(ctx.mcp, v.id, VAULT_W, "maxWithdraw", [user], ctx.block).then((x) => x, () => null);
    },
  };
}
