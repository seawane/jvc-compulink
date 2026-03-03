import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { CompuLinkAccessory } from './compulinkAccessory.js';
import { CompuLinkTransmitter } from './compulinkTransmitter.js';

interface CommandConfig {
  name: string;
  code: string;
}

export class CompuLinkPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public transmitter!: CompuLinkTransmitter;

  private readonly cachedAccessories: Map<string, PlatformAccessory> = new Map();

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      const gpioPin = (this.config.gpioPin as number) ?? 17;
      const invertSignal = (this.config.invertSignal as boolean) ?? false;

      this.transmitter = new CompuLinkTransmitter(this.log, gpioPin, invertSignal);
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      this.transmitter?.destroy();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached accessory:', accessory.displayName);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private discoverDevices(): void {
    const commands: CommandConfig[] = (this.config.commands as CommandConfig[]) ?? [
      { name: 'Tape Play', code: '0x20' },
      { name: 'Tape Stop', code: '0x22' },
      { name: 'Tape Pause', code: '0x25' },
    ];

    const activeUUIDs = new Set<string>();

    for (const cmd of commands) {
      const commandCode = parseInt(cmd.code, 16);
      if (isNaN(commandCode)) {
        this.log.warn(`Invalid command code "${cmd.code}" for "${cmd.name}", skipping`);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`compulink-${cmd.code}`);
      activeUUIDs.add(uuid);

      const existing = this.cachedAccessories.get(uuid);

      if (existing) {
        this.log.info('Restoring accessory from cache:', cmd.name);
        existing.context.commandCode = commandCode;
        existing.context.commandName = cmd.name;
        new CompuLinkAccessory(this, existing);
      } else {
        this.log.info('Adding new accessory:', cmd.name);
        const accessory = new this.api.platformAccessory(cmd.name, uuid);
        accessory.context.commandCode = commandCode;
        accessory.context.commandName = cmd.name;
        new CompuLinkAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Remove accessories no longer in config
    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!activeUUIDs.has(uuid)) {
        this.log.info('Removing stale accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.delete(uuid);
      }
    }
  }
}
