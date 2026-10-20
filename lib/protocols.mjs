// Read-only protocol adapters for Pharos mainnet, shared by the portfolio, yield and aggregator agents.
// Every figure carries its source: { contract, call, block }. A read that fails is reported as unknown with the
// reason, never filled in.
import { erc20Abi, formatUnits, parseAbi } from "viem";
import { NATIVE, TOKENS, read, readAgreed } from "./pharos.mjs";
import { IRM_ABI, MORPHO_ABI, accruedTotalBorrow } from "../liquidation-watchdog/morpho.mjs";

export const MORPHO = "0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb";
export const VAULT_ABI = parseAbi([
  "function asset() view returns (address)",
  "function share() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
]);
const SECONDS_PER_YEAR = 31_536_000;
const src = (contract, call, block) => ({ contract, call, block });
const num = (raw, dec) => Number(formatUnits(BigInt(raw), dec));
const tokenMeta = {};
export async function token(mcp, a) {
  a = a.toLowerCase();
  if (TOKENS[a]) return { address: a, ...TOKENS[a] };
  if (/^0x0{40}$/.test(a)) return { address: a, symbol: "none", decimals: 18 }; // e.g. an idle Morpho market (no collateral)
  return (tokenMeta[a] ??= { address: a, symbol: await read(mcp, a, erc20Abi, "symbol"), decimals: Number(await read(mcp, a, erc20Abi, "decimals")) });
}
const tryRead = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, why: (/"message":\s*"([^"]*)"/.exec(e.message)?.[1] || e.message.split("\n")[0]).slice(0, 80) || "reverted" }));

/** Native PROS and every known token, for one wallet at one block. */
export async function walletBalances(mcp, wallet, block, extraTokens = []) {
  const out = [];
  const { balanceWei } = await mcp.call("get_balance", { address: wallet, block: String(block) });
  out.push({ symbol: NATIVE, amount: num(balanceWei, 18), raw: BigInt(balanceWei), source: src(wallet, "get_balance", block) });
  for (const a of [...Object.keys(TOKENS), ...extraTokens]) {
    const t = await token(mcp, a);
    const r = await tryRead(read(mcp, a, erc20Abi, "balanceOf", [wallet], block));
    if (!r.ok) out.push({ symbol: t.symbol, unknown: true, why: r.why, source: src(a, "balanceOf", block) });
    else if (r.v > 0n) out.push({ symbol: t.symbol, token: a, amount: num(r.v, t.decimals), raw: r.v, source: src(a, "balanceOf", block) });
  }
  return out;
}

/**
 * A tokenized vault (ERC-4626, or ERC-7575 with a separate share token). Yield = growth of the share price
 * (assets per share) over `days`, annualized; both prices read at pinned blocks with two agreeing reads.
 */
export async function vault(mcp, v, block, { days = 7, user } = {}) {
  const shareTok = await tryRead(read(mcp, v.address, VAULT_ABI, "share", [], block));
  const shareAddr = (shareTok.ok ? shareTok.v : v.address).toLowerCase();
  const asset = await token(mcp, await read(mcp, v.address, VAULT_ABI, "asset", [], block));
  const share = await token(mcp, shareAddr);
  const one = 10n ** BigInt(share.decimals);
  const pastBlock = block - Math.round(days * 86400); // ~1 s blocks
  const [now, past] = [
    await tryRead(readAgreed(mcp, v.address, VAULT_ABI, "convertToAssets", [one], block)),
    await tryRead(readAgreed(mcp, v.address, VAULT_ABI, "convertToAssets", [one], pastBlock)),
  ];
  const tvl = await tryRead(read(mcp, v.address, VAULT_ABI, "totalAssets", [], block));
  const out = {
    kind: "vault", label: v.label, address: v.address, share: shareAddr, shareSymbol: share.symbol, asset: asset.symbol, assetAddress: asset.address,
    tvl: tvl.ok ? num(tvl.v, asset.decimals) : null, tvlSource: src(v.address, "totalAssets()", block),
    sharePrice: now.ok ? num(now.v, asset.decimals) : null, priceSource: src(v.address, `convertToAssets(1e${share.decimals})`, block),
  };
  if (now.ok && past.ok && past.v > 0n) {
    const growth = Number(now.v) / Number(past.v);
    Object.assign(out, { apy: (growth ** (365 / days) - 1) * 100, apySource: `share price ${num(past.v, asset.decimals)} at block ${pastBlock} → ${num(now.v, asset.decimals)} at block ${block}`, apyDays: days });
  } else out.apyUnknown = now.ok ? `no share price ${days} days ago (${past.why ?? "zero"})` : `share price unreadable (${now.why})`;

  // Entry/exit costs, where the vault exposes previews: previewDeposit vs convertToShares, previewRedeem vs convertToAssets.
  const probe = 1000n * 10n ** BigInt(asset.decimals);
  const [pd, cs] = [await tryRead(read(mcp, v.address, VAULT_ABI, "previewDeposit", [probe], block)), await tryRead(read(mcp, v.address, VAULT_ABI, "convertToShares", [probe], block))];
  out.entryFeePct = pd.ok && cs.ok && cs.v > 0n ? (1 - Number(pd.v) / Number(cs.v)) * 100 : null;
  out.entryFeeWhy = pd.ok ? null : `previewDeposit not available (${pd.why}): deposits may be asynchronous or gated`;
  const [pr, ca] = [await tryRead(read(mcp, v.address, VAULT_ABI, "previewRedeem", [one * 1000n], block)), await tryRead(read(mcp, v.address, VAULT_ABI, "convertToAssets", [one * 1000n], block))];
  out.exitFeePct = pr.ok && ca.ok && ca.v > 0n ? (1 - Number(pr.v) / Number(ca.v)) * 100 : null;
  out.exitFeeWhy = pr.ok ? null : `previewRedeem not available (${pr.why}): redemptions may be asynchronous or locked`;
  Object.assign(out, await redemption(mcp, v.address));
  // A sync redeem function is not an exit by itself: the vault must hold the asset on chain to pay it. (The RPC-AKU
  // vault has sync `withdraw`, holds 0 USDC, and its withdraw reverts AccessControlUnauthorizedAccount for its holder.)
  const onHand = await tryRead(read(mcp, asset.address, erc20Abi, "balanceOf", [v.address], block));
  out.onHandAssets = onHand.ok ? num(onHand.v, asset.decimals) : null;
  out.exitVerified = out.redemptionMode === "sync" && out.exitFeePct != null && out.onHandAssets > 0;
  if (out.redemptionMode === "sync" && !(out.onHandAssets > 0))
    out.redemptionNote += `; but the vault holds ${out.onHandAssets ?? "?"} ${asset.symbol} on chain, so nothing can be paid out from it directly`;

  if (user) {
    const bal = await tryRead(read(mcp, shareAddr, erc20Abi, "balanceOf", [user], block));
    if (!bal.ok) out.position = { unknown: true, why: bal.why };
    else if (bal.v > 0n) {
      const assets = await tryRead(read(mcp, v.address, VAULT_ABI, "convertToAssets", [bal.v], block));
      const mr = await tryRead(read(mcp, v.address, VAULT_ABI, "maxRedeem", [user], block));
      out.position = {
        shares: num(bal.v, share.decimals), shareSource: src(shareAddr, "balanceOf(user)", block),
        assets: assets.ok ? num(assets.v, asset.decimals) : null, assetSource: src(v.address, "convertToAssets(shares)", block),
        redeemableNow: mr.ok ? num(mr.v, share.decimals) : null, redeemWhy: mr.ok ? null : `maxRedeem not readable (${mr.why})`,
      };
    }
  }
  return out;
}

/**
 * How redemptions work, from the code that runs (the EIP-1967 implementation when the vault is a proxy):
 * ERC-7540 `requestRedeem` means exits go through a request queue the vault operator settles later;
 * plain `redeem`/`withdraw` without it means synchronous redemption (subject to the vault's liquidity).
 * A previewRedeem that works is not enough: an async vault can still answer it.
 */
const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SEL = { requestRedeem: "7d41c86e", redeem: "ba087652", withdraw: "b460af94" };
export async function redemption(mcp, address) {
  const codeOf = async (a) => { const c = await mcp.call("get_code", { address: a }); return c.code ?? c; };
  let code = await codeOf(address);
  let impl = null;
  const s = await mcp.call("get_storage_at", { address, position: EIP1967_IMPL });
  const slot = "0x" + String(s.value ?? s).slice(-40);
  if (!/^0x0{40}$/.test(slot)) {
    impl = slot.toLowerCase();
    code = await codeOf(impl);
  }
  const has = (k) => code.includes("63" + SEL[k]);
  const redemptionMode = has("requestRedeem") ? "async" : has("redeem") || has("withdraw") ? "sync" : "unknown";
  return {
    redemptionMode, implementation: impl,
    redemptionNote: redemptionMode === "async" ? `exits are ERC-7540 requests (requestRedeem in ${impl ?? address}): timing set by the vault, not guaranteed`
      : redemptionMode === "sync" ? `synchronous redeem/withdraw (${impl ?? address}); instant only while the vault has liquidity`
      : `no redeem or requestRedeem found in ${impl ?? address}: exit terms unknown`,
  };
}

/**
 * A Morpho Blue market: supply APY (borrow rate × utilization × (1 − fee)), utilization, available liquidity, and
 * optionally a user's supply / borrow / collateral, with interest accrued to the block's time.
 */
export async function morphoMarket(mcp, id, block, { user, now } = {}) {
  const mp = await read(mcp, MORPHO, MORPHO_ABI, "idToMarketParams", [id], block);
  const [loan, coll] = [await token(mcp, mp[0]), await token(mcp, mp[1])];
  const mk = await readAgreed(mcp, MORPHO, MORPHO_ABI, "market", [id], block);
  const rate = /^0x0+$/.test(mp[3]) ? 0n : await read(mcp, mp[3], IRM_ABI, "borrowRateView", [mp, mk], block);
  const t = now ?? Number(mk[4]);
  const totalBorrow = accruedTotalBorrow(mk[2], mk[4], t, rate);
  const elapsed = BigInt(Math.max(0, t - Number(mk[4])));
  const interest = totalBorrow - mk[2];
  const totalSupply = mk[0] + interest; // Morpho adds all interest to supply assets (the fee is paid in new shares)
  const util = totalSupply > 0n ? Number(totalBorrow) / Number(totalSupply) : 0;
  const borrowApy = (Math.exp((Number(rate) / 1e18) * SECONDS_PER_YEAR) - 1) * 100;
  const supplyApy = borrowApy * util * (1 - Number(mk[5]) / 1e18);
  const out = {
    kind: "morpho", id, label: `Morpho ${coll.symbol}/${loan.symbol}`, loan: loan.symbol, loanAddress: loan.address, collateral: coll.symbol, lltv: Number(mp[4]) / 1e16,
    params: { loanToken: mp[0], collateralToken: mp[1], oracle: mp[2], irm: mp[3], lltv: mp[4] },
    supplied: num(totalSupply, loan.decimals), borrowed: num(totalBorrow, loan.decimals), liquidity: num(totalSupply - totalBorrow, loan.decimals),
    utilization: util * 100, borrowApy, supplyApy, fee: Number(mk[5]) / 1e16, accruedFor: Number(elapsed),
    source: src(MORPHO, `market(${id.slice(0, 10)}…), ${mp[3].slice(0, 10)}….borrowRateView`, block),
  };
  if (user) {
    const pos = await readAgreed(mcp, MORPHO, MORPHO_ABI, "position", [id, user], block);
    const supplyAssets = mk[1] > 0n ? (pos[0] * (totalSupply + 1n)) / (mk[1] + 10n ** 6n) : 0n;
    const borrowAssets = pos[1] > 0n ? (pos[1] * (totalBorrow + 1n) + mk[3] + 10n ** 6n - 1n) / (mk[3] + 10n ** 6n) : 0n;
    if (pos[0] > 0n || pos[1] > 0n || pos[2] > 0n) {
      out.position = { supplied: num(supplyAssets, loan.decimals), borrowed: num(borrowAssets, loan.decimals), collateral: num(pos[2], coll.decimals), source: src(MORPHO, `position(${id.slice(0, 10)}…, user)`, block) };
      if (pos[2] > 0n) {
        // The market's own oracle prices the collateral in loan-token units (scale 1e36 · 10^(loanDec − collDec)).
        const p = await readAgreed(mcp, mp[2], parseAbi(["function price() view returns (uint256)"]), "price", [], block);
        const perUnit = (Number(p) / 1e36) * 10 ** (coll.decimals - loan.decimals);
        const value = out.position.collateral * perUnit;
        Object.assign(out.position, {
          collateralPrice: perUnit, collateralValue: value, priceSource: src(mp[2], "price() (market oracle)", block),
          healthFactor: out.position.borrowed > 0 ? (value * (Number(mp[4]) / 1e18)) / out.position.borrowed : Infinity,
        });
      }
    }
  }
  return out;
}
