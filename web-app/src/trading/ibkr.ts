/**
 * IBKR TWS API connection wrapper.
 *
 * Manages the socket connection to IB Gateway (with auto-reconnect), order placement,
 * and order status tracking via callbacks. Prices come from Yahoo (see quotes.ts),
 * so no IBKR market data subscription is needed.
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

export interface OrderFill {
  ibkrOrderId: number;
  status: string;       // Submitted, PreSubmitted, Filled, Cancelled, Inactive
  filled: number;
  remaining: number;
  avgFillPrice: number;
}

export type OnOrderStatusCallback = (fill: OrderFill) => void;

// ── IBKR Client ──

export class IBKRClient {
  private ib: IBApi;
  private nextOrderId: number = 0;
  private onOrderStatus: OnOrderStatusCallback | null = null;

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
      console.log(`[IBKR] Connected to ${this.host}:${this.port}`);
    });

    this.ib.on(EventName.disconnected, () => {
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

  // ── Orders ──

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
   * Place a Market on Open (MOO) order — a market order that participates in the
   * opening auction (IBKR: MKT + TIF=OPG). Must be submitted before the open.
   * Returns the IBKR order ID.
   */
  placeMOOOrder(
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
      tif: TimeInForce.OPG,
      transmit: true,
    };

    this.ib.placeOrder(orderId, contract, order);
    console.log(
      `[IBKR] Placed ${action} MOO order #${orderId}: ${quantity} ${symbol}`,
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

  // ── Callbacks ──

  setOnOrderStatus(cb: OnOrderStatusCallback) {
    this.onOrderStatus = cb;
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
    } catch (err) {
      this.reconnecting = false;
      console.error('[IBKR] Reconnect failed:', (err as Error).message);
      this.scheduleReconnect();
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
