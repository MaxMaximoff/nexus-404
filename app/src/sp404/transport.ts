// Byte-stream transports. The SP-404MKII exposes its control link as a CDC-ACM serial port
// (USB 0582:02E7), which Chromium reaches through Web Serial.

export const USB_VID = 0x0582;
export const USB_PID_SERIAL = 0x02e7;

export interface SP404Transport {
  open(): Promise<void>;
  close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  onBytes: (bytes: Uint8Array) => void;
  /** Called once when the link drops on its own (cable pulled, device off). */
  onLost: (reason: string) => void;
}

const BAUD = 921600;
const SETTLE_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isSp404Port = (p: SerialPort): boolean => {
  const i = p.getInfo();
  return i.usbVendorId === USB_VID && i.usbProductId === USB_PID_SERIAL;
};

export class WebSerialTransport implements SP404Transport {
  onBytes: (bytes: Uint8Array) => void = () => {};
  onLost: (reason: string) => void = () => {};
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private loopDone: Promise<void> | null = null;
  private closing = false;

  constructor(readonly port: SerialPort) {}

  static supported(): boolean {
    return typeof navigator !== "undefined" && "serial" in navigator;
  }

  /** Ports this origin was already granted: reconnect without the chooser. */
  static async grantedPorts(): Promise<SerialPort[]> {
    return WebSerialTransport.supported() ? (await navigator.serial.getPorts()).filter(isSp404Port) : [];
  }

  /** Show the browser's port chooser (needs a user gesture). */
  static async request(): Promise<SerialPort> {
    return navigator.serial.requestPort({ filters: [{ usbVendorId: USB_VID, usbProductId: USB_PID_SERIAL }] });
  }

  async open(): Promise<void> {
    // bufferSize defaults to 255 bytes; file reads arrive in 20 KB chunks.
    await this.port.open({ baudRate: BAUD, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", bufferSize: 1 << 20 });
    // The official app asserts DTR + RTS and pauses before its first message.
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    await sleep(SETTLE_MS);
    this.writer = this.port.writable!.getWriter();
    this.loopDone = this.readLoop();
  }

  private async readLoop(): Promise<void> {
    let reason = "port closed";
    try {
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value?.length) this.onBytes(value);
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    } catch (e) {
      reason = (e as Error).message;
    }
    if (!this.closing) this.onLost(reason);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) throw new Error("port is not open");
    await this.writer.write(bytes);
  }

  async close(): Promise<void> {
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* already gone */ }
    try { await this.loopDone; } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* ignore */ }
  }
}
