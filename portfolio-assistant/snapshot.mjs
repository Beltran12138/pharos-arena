// One wallet's positions across the wallet itself, tokenized vaults and Morpho Blue, valued in USD, at one block.
// Every row keeps the source of its numbers; what cannot be read or priced is listed, not estimated.
import { readFeed } from "../lib/pharos.mjs";
import { morphoMarket, vault, walletBalances } from "../lib/protocols.mjs";

const fmt = (x) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
export const NOT_COVERED = ["Uniswap V3 LP positions (position NFTs)", "staking or delegation", "any protocol not listed in lib/protocols.json"];

export async function snapshot(mcp, wallet, reg) {
  const block = Number((await mcp.call("get_block_number")).blockNumber);
  const now = Number(BigInt((await mcp.call("get_block", { block: String(block) })).timestamp));
  const unreadable = [];
  const feeds = {};
  for (const pair of ["PROS/USD", "USDC/USD", "ETH/USD", "LINK/USD"]) feeds[pair] = await readFeed(mcp, pair, block);
  const usdOf = { USDC: feeds["USDC/USD"], PROS: feeds["PROS/USD"], WPROS: feeds["PROS/USD"], WETH: feeds["ETH/USD"], LINK: feeds["LINK/USD"] };
  const price = (sym) => (usdOf[sym] ? { usd: usdOf[sym].price, source: `Chainlink ${usdOf[sym].pair} ${usdOf[sym].address} at block ${block}` } : null);

  // Vaults: market data for all (needed to value shares used as collateral elsewhere), positions for the wallet.
  const vaults = [];
  for (const v of reg.vaults) {
    try {
      vaults.push(await vault(mcp, v, block, { user: wallet }));
    } catch (e) {
      unreadable.push({ what: `vault ${v.label} (${v.address})`, why: e.message.split("\n")[0].slice(0, 100) });
    }
  }
  const shareValue = (shareAddr) => {
    const v = vaults.find((x) => x.share === shareAddr.toLowerCase() || x.shareSymbol === shareAddr);
    const p = v && price(v.asset);
    return v && p && v.sharePrice != null ? { usd: v.sharePrice * p.usd, vault: v, source: `${v.label} share price ${v.sharePrice} ${v.asset} (${v.address}.convertToAssets at block ${block}) × ${p.source}` } : null;
  };

  const rows = [];
  for (const b of await walletBalances(mcp, wallet, block, vaults.map((v) => v.share))) {
    if (b.unknown) {
      unreadable.push({ what: `${b.symbol} balance`, why: b.why });
      continue;
    }
    const p = price(b.symbol) ?? (b.token && shareValue(b.token));
    rows.push({ protocol: "wallet", what: `${b.symbol} in the wallet`, asset: b.symbol, amount: b.amount, usd: p ? b.amount * p.usd : null, apy: p?.vault?.apy ?? null,
      sources: [`${b.source.contract}.${b.source.call} at block ${block}`, p ? p.source : "no price source for this token"] });
  }
  for (const v of vaults) {
    if (v.position?.unknown) unreadable.push({ what: `${v.label} shares`, why: v.position.why });
    else if (v.position && !rows.some((r) => r.asset === v.shareSymbol)) {
      const p = price(v.asset);
      rows.push({ protocol: "vault", what: `${v.label}: ${fmt(v.position.shares)} ${v.shareSymbol}`, asset: v.asset, amount: v.position.assets, usd: p ? v.position.assets * p.usd : null, apy: v.apy ?? null,
        redeemableNow: v.position.redeemableNow, sources: [`${v.position.shareSource.contract}.balanceOf at block ${block}`, `${v.address}.convertToAssets at block ${block}`, v.apySource ?? v.apyUnknown] });
    }
  }

  const markets = [];
  for (const id of reg.morphoMarkets) {
    try {
      const m = await morphoMarket(mcp, id, block, { user: wallet, now });
      markets.push(m);
      const pos = m.position;
      if (!pos) continue;
      const loanP = price(m.loan);
      const at = `${pos.source.contract}.${pos.source.call} at block ${block}`;
      if (pos.supplied > 0)
        rows.push({ protocol: "morpho", what: `${m.label}: supplied ${m.loan}`, asset: m.loan, amount: pos.supplied, usd: loanP ? pos.supplied * loanP.usd : null, apy: m.supplyApy,
          sources: [at, `${m.source.contract} ${m.source.call}`, loanP?.source ?? "no price"] });
      if (pos.collateral > 0) {
        const sv = shareValue(m.collateral);
        const usd = sv ? pos.collateral * sv.usd : loanP ? pos.collateralValue * loanP.usd : null;
        rows.push({ protocol: "morpho", what: `${m.label}: ${fmt(pos.collateral)} ${m.collateral} as collateral`, asset: m.collateral, amount: pos.collateral, usd, apy: sv?.vault?.apy ?? null,
          apyNote: sv ? `collateral is ${sv.vault.label} shares: it keeps earning the vault's yield` : `whether ${m.collateral} itself earns anything is not readable here`,
          sources: [at, sv ? sv.source : `${pos.priceSource.contract}.price() at block ${block} × ${loanP?.source}`] });
      }
      if (pos.borrowed > 0)
        rows.push({ protocol: "morpho", what: `${m.label}: borrowed ${m.loan}`, asset: m.loan, amount: -pos.borrowed, usd: loanP ? -pos.borrowed * loanP.usd : null, apy: m.borrowApy, debt: true, healthFactor: pos.healthFactor, lltv: m.lltv,
          sources: [at, `${m.source.contract} ${m.source.call} (interest accrued to block time)`] });
    } catch (e) {
      unreadable.push({ what: `Morpho market ${id.slice(0, 10)}…`, why: e.message.split("\n")[0].slice(0, 100) });
    }
  }
  return { wallet, block, time: new Date(now * 1000).toISOString(), rows, vaults, markets, unreadable, notCovered: NOT_COVERED };
}
