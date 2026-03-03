import type { Logging } from 'homebridge';

// pigpio types - conditionally loaded at runtime (only available on Raspberry Pi)
interface GpioInstance {
  digitalWrite(value: number): void;
}

interface PigpioModule {
  Gpio: {
    new(pin: number, options: { mode: number }): GpioInstance;
    OUTPUT: number;
  };
  waveClear(): void;
  waveAddGeneric(pulses: GenericWaveStep[]): void;
  waveCreate(): number;
  waveDelete(waveId: number): void;
  waveTxSend(waveId: number, mode: number): void;
  waveTxBusy(): boolean;
  WAVE_MODE_ONE_SHOT: number;
}

interface GenericWaveStep {
  gpioOn: number;
  gpioOff: number;
  usDelay: number;
}

const BIT_HIGH_US = 5000;   // HIGH pulse duration: always 5ms
const BIT_ZERO_LOW_US = 5000;  // LOW duration for "0" bit: 5ms
const BIT_ONE_LOW_US = 15000;  // LOW duration for "1" bit: 15ms

export class CompuLinkTransmitter {
  private gpio: GpioInstance | null = null;
  private pigpio: PigpioModule | null = null;
  private busy = false;
  private gpioMask: number;

  constructor(
    private readonly log: Logging,
    private readonly gpioPin: number,
    private readonly invertSignal: boolean,
  ) {
    this.gpioMask = 1 << gpioPin;

    try {
      // Dynamic require - pigpio is only available on Raspberry Pi
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pigpioModule = require('pigpio') as PigpioModule;
      this.pigpio = pigpioModule;
      this.gpio = new pigpioModule.Gpio(gpioPin, { mode: pigpioModule.Gpio.OUTPUT });

      // Idle state: CompuLink line LOW
      // Non-inverting: GPIO LOW = line LOW
      // Inverting (NPN): GPIO HIGH = line LOW
      this.gpio.digitalWrite(invertSignal ? 1 : 0);
      this.log.info(`CompuLink transmitter initialized on GPIO ${gpioPin}`);
    } catch {
      this.log.warn('pigpio not available - running in mock mode (no GPIO output)');
    }
  }

  async sendCommand(commandByte: number): Promise<void> {
    if (this.busy) {
      this.log.warn('Transmitter busy, dropping command 0x' + commandByte.toString(16));
      return;
    }

    this.busy = true;

    try {
      if (!this.pigpio) {
        this.log.info(`[MOCK] CompuLink command: 0x${commandByte.toString(16).padStart(2, '0')}`);
        await this.delay(150);
        return;
      }

      const pulses = this.buildWaveform(commandByte);

      this.pigpio.waveClear();
      this.pigpio.waveAddGeneric(pulses);
      const waveId = this.pigpio.waveCreate();
      this.pigpio.waveTxSend(waveId, this.pigpio.WAVE_MODE_ONE_SHOT);

      await this.waitForWaveComplete();

      this.pigpio.waveDelete(waveId);

      this.log.debug(`CompuLink command sent: 0x${commandByte.toString(16).padStart(2, '0')}`);
    } finally {
      this.busy = false;
    }
  }

  private buildWaveform(commandByte: number): GenericWaveStep[] {
    const pulses: GenericWaveStep[] = [];

    // Determine pulse mappings based on signal inversion
    // Non-inverting (direct/BSS138): GPIO HIGH = line HIGH
    // Inverting (NPN transistor):    GPIO LOW  = line HIGH (transistor off, pull-up active)
    const lineHigh: Omit<GenericWaveStep, 'usDelay'> = this.invertSignal
      ? { gpioOn: 0, gpioOff: this.gpioMask }
      : { gpioOn: this.gpioMask, gpioOff: 0 };

    const lineLow: Omit<GenericWaveStep, 'usDelay'> = this.invertSignal
      ? { gpioOn: this.gpioMask, gpioOff: 0 }
      : { gpioOn: 0, gpioOff: this.gpioMask };

    // Transmit 8 bits, MSB first
    for (let i = 7; i >= 0; i--) {
      const bit = (commandByte >> i) & 1;

      // HIGH pulse: always 5ms
      pulses.push({ ...lineHigh, usDelay: BIT_HIGH_US });

      // LOW period: 5ms for "0", 15ms for "1"
      pulses.push({ ...lineLow, usDelay: bit ? BIT_ONE_LOW_US : BIT_ZERO_LOW_US });
    }

    // Word terminator: 5ms HIGH pulse
    pulses.push({ ...lineHigh, usDelay: BIT_HIGH_US });

    // Return to idle LOW
    pulses.push({ ...lineLow, usDelay: 1 });

    return pulses;
  }

  private waitForWaveComplete(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.pigpio && this.pigpio.waveTxBusy()) {
          setTimeout(check, 1);
        } else {
          resolve();
        }
      };
      check();
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  destroy(): void {
    if (this.gpio) {
      // Return line to idle LOW
      this.gpio.digitalWrite(this.invertSignal ? 1 : 0);
      this.log.info('CompuLink transmitter shut down');
    }
  }
}
