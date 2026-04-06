/**
 * IBKR TWS API connection wrapper.
 *
 * Manages the socket connection to IB Gateway, order placement/cancellation,
 * streaming market data, and order status tracking via callbacks.
 */

import {
  IBApi,
  EventName,
  Contract,
  Order as IBOrder,
  OrderAction,
  OrderType,
  TimeInForce,
  SecType,
} from '@stoqey/ib';

// ── Types ──

export interface MarketTick {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
}

export interface OrderFill {
  ibkrOrderId: number;
  status: string;       // Submitted, PreSubmitted, Filled, Cancelled, Inactive
  filled: number;
  remaining: number;
  avgFillPrice: number;
}

export type OnTickCallback = (tick: MarketTick) => void;
export type OnOrderStatusCallback = (fill: OrderFill) => void;
export type OnReconnectCallback = () => void;

// ── IBKR Client ──

export class IBKRClient {
  private ib: IBApi;
  private nextOrderId: number = 0;
  private connected = false;
  private onTick: OnTickCallback | null = null;
  private onOrderStatus: OnOrderStatusCallback | null = null;
  private onReconnect: OnReconnectCallback | null = null;

  // Market data tracking: reqId → symbol, and symbol → latest bid/ask
  private reqIdToSymbol = new Map<number, string>();
  private symbolToReqId = new Map<string, number>();
  private nextReqId = 1000;
  private quotes = new Map<string, MarketTick>();

  // Reconnection state
  private intentionalDisconnect = false;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private static readonly RECONNECT_DELAYS = [5, 10, 30, 60]; // seconds, then 60s forever

  constructor(
    private host = '127.0.0.1',
    private port = 4002, // 4002 = paper IB Gateway, 4001 = live
    private clientId = 1,
  ) {
    this.ib = new IBApi({ host, port, clientId });
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.ib.on(EventName.connected, () => {
      this.connected = true;
      console.log(`[IBKR] Connected to ${this.host}:${this.port}`);
    });

    this.ib.on(EventName.disconnected, () => {
      this.connected = false;
      console.log('[IBKR] Disconnected');
      if (!this.intentionalDisconnect && !this.reconnecting) {
        this.scheduleReconnect();
      }
    });

    this.ib.on(EventName.nextValidId, (id: number) => {
      this.nextOrderId = id;
      console.log(`[IBKR] Next valid order ID: ${id}`);
    });

    this.ib.on(EventName.error, (err: Error, code: number, reqId: number) => {
      // Informational messages — not errors
      if (code === 2104 || code === 2106 || code === 2158) return;
      // All other errors/warnings: just log. Order lifecycle is handled
      // entirely by the orderStatus callback (Filled, Cancelled, Inactive).
      console.warn(`[IBKR] Error ${code} (reqId=${reqId}):`, err.message);
    });

    // Order status updates
    this.ib.on(
      EventName.orderStatus,
      (
        orderId: number,
        status: string,
        filled: number,
        remaining: number,
        avgFillPrice: number,
      ) => {
        console.log(
          `[IBKR] Order ${orderId}: ${status} | filled=${filled} remaining=${remaining} avgPrice=${avgFillPrice}`,
        );
        if (this.onOrderStatus) {
          this.onOrderStatus({ ibkrOrderId: orderId, status, filled, remaining, avgFillPrice });
        }
      },
    );

    // Streaming market data — tick price updates
    this.ib.on(EventName.tickPrice, (reqId: number, tickType: number, price: number) => {
      const symbol = this.reqIdToSymbol.get(reqId);
      if (!symbol || price <= 0) return;

      const tick = this.quotes.get(symbol) || { symbol, bid: 0, ask: 0, last: 0 };

      // tickType: 1 = bid, 2 = ask, 4 = last
      if (tickType === 1) tick.bid = price;
      else if (tickType === 2) tick.ask = price;
      else if (tickType === 4) tick.last = price;

      this.quotes.set(symbol, tick);

      if (tick.bid > 0 && tick.ask > 0 && this.onTick) {
        this.onTick(tick);
      }
    });
  }

  // ── Connection ──

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);

      this.ib.once(EventName.nextValidId, () => {
        clearTimeout(timeout);
        resolve();
      });

      this.ib.connect();
    });
  }

  disconnect() {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ib.disconnect();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Order Reconciliation ──

  /**
   * Request status of all open orders from IBKR.
   * Triggers orderStatus callbacks for each, letting the engine reconcile.
   */
  reqAllOpenOrders() {
    this.ib.reqAllOpenOrders();
  }

  // ── Market Data ──

  subscribeMarketData(symbol: string) {
    if (this.symbolToReqId.has(symbol)) return; // already subscribed

    const reqId = this.nextReqId++;
    this.reqIdToSymbol.set(reqId, symbol);
    this.symbolToReqId.set(symbol, reqId);

    const contract = this.stockContract(symbol);
    // genericTickList "" = default ticks, snapshot = false for streaming
    this.ib.reqMktData(reqId, contract, '', false, false);
    console.log(`[IBKR] Subscribed to market data: ${symbol} (reqId=${reqId})`);
  }

  unsubscribeMarketData(symbol: string) {
    const reqId = this.symbolToReqId.get(symbol);
    if (reqId === undefined) return;

    this.ib.cancelMktData(reqId);
    this.reqIdToSymbol.delete(reqId);
    this.symbolToReqId.delete(symbol);
    this.quotes.delete(symbol);
    console.log(`[IBKR] Unsubscribed: ${symbol}`);
  }

  getQuote(symbol: string): MarketTick | undefined {
    return this.quotes.get(symbol);
  }

  // ── Orders ──

  /**
   * Place a market order (whole shares). Returns the IBKR order ID.
   */
  placeMarketOrder(
    symbol: string,
    action: 'BUY' | 'SELL',
    quantity: number,
  ): number {
    const orderId = this.nextOrderId++;
    const contract = this.stockContract(symbol);

    const order: IBOrder = {
      action: action === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
      orderType: OrderType.MKT,
      totalQuantity: quantity,
      tif: TimeInForce.DAY,
      transmit: true,
    };

    this.ib.placeOrder(orderId, contract, order);
    console.log(
      `[IBKR] Placed ${action} MKT order #${orderId}: ${quantity} ${symbol}`,
    );
    return orderId;
  }

  /**
   * Place a Limit on Close (LOC) order. Returns the IBKR order ID.
   */
  placeLOCOrder(
    symbol: string,
    action: 'BUY' | 'SELL',
    quantity: number,
    limitPrice: number
  ): number {
    const orderId = this.nextOrderId++;
    const contract = this.stockContract(symbol);

    const order: IBOrder = {
      action: action === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
      orderType: OrderType.LOC,
      lmtPrice: limitPrice,
      totalQuantity: quantity,
      tif: TimeInForce.DAY,
      transmit: true,
    };

    this.ib.placeOrder(orderId, contract, order);
    console.log(
      `[IBKR] Placed ${action} LOC order #${orderId}: ${quantity} ${symbol} @ $${limitPrice.toFixed(2)}`,
    );
    return orderId;
  }

  /**
   * Place a Market on Close (MOC) order. Returns the IBKR order ID.
   */
  placeMOCOrder(
    symbol: string,
    action: 'BUY' | 'SELL',
    quantity: number,
  ): number {
    const orderId = this.nextOrderId++;
    const contract = this.stockContract(symbol);

    const order: IBOrder = {
      action: action === 'BUY' ? OrderAction.BUY : OrderAction.SELL,
      orderType: OrderType.MOC,
      totalQuantity: quantity,
      tif: TimeInForce.DAY,
      transmit: true,
    };

    this.ib.placeOrder(orderId, contract, order);
    console.log(
      `[IBKR] Placed ${action} MOC order #${orderId}: ${quantity} ${symbol}`,
    );
    return orderId;
  }

  cancelOrder(ibkrOrderId: number) {
    this.ib.cancelOrder(ibkrOrderId);
    console.log(`[IBKR] Cancel requested for order #${ibkrOrderId}`);
  }

  // ── Callbacks ──

  setOnTick(cb: OnTickCallback) {
    this.onTick = cb;
  }

  setOnOrderStatus(cb: OnOrderStatusCallback) {
    this.onOrderStatus = cb;
  }

  setOnReconnect(cb: OnReconnectCallback) {
    this.onReconnect = cb;
  }

  // ── Reconnection ──

  private scheduleReconnect() {
    const delayIdx = Math.min(this.reconnectAttempt, IBKRClient.RECONNECT_DELAYS.length - 1);
    const delaySec = IBKRClient.RECONNECT_DELAYS[delayIdx];
    this.reconnectAttempt++;

    console.log(`[IBKR] Reconnecting in ${delaySec}s (attempt ${this.reconnectAttempt})...`);
    this.reconnectTimer = setTimeout(() => this.attemptReconnect(), delaySec * 1000);
  }

  private async attemptReconnect() {
    this.reconnecting = true;
    try {
      await this.connect();
      this.reconnecting = false;
      console.log('[IBKR] Reconnected successfully');
      this.reconnectAttempt = 0;
      this.resubscribeAll();
      if (this.onReconnect) this.onReconnect();
    } catch (err) {
      this.reconnecting = false;
      console.error('[IBKR] Reconnect failed:', (err as Error).message);
      this.scheduleReconnect();
    }
  }

  private resubscribeAll() {
    for (const [symbol, reqId] of this.symbolToReqId) {
      const contract = this.stockContract(symbol);
      this.ib.reqMktData(reqId, contract, '', false, false);
      console.log(`[IBKR] Re-subscribed: ${symbol} (reqId=${reqId})`);
    }
  }

  // ── Helpers ──

  private stockContract(symbol: string): Contract {
    return {
      symbol,
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD',
    };
  }
}
