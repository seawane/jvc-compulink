import type { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import type { CompuLinkPlatform } from './platform.js';

export class CompuLinkAccessory {
  private readonly service: Service;
  private readonly commandCode: number;
  private readonly commandName: string;

  constructor(
    private readonly platform: CompuLinkPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.commandCode = this.accessory.context.commandCode as number;
    this.commandName = this.accessory.context.commandName as string;

    // Accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'JVC')
      .setCharacteristic(this.platform.Characteristic.Model, 'TD-V541 CompuLink')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `CL-${this.commandCode.toString(16).padStart(2, '0')}`);

    // Get or create Switch service
    this.service = this.accessory.getService(this.platform.Service.Switch)
      ?? this.accessory.addService(this.platform.Service.Switch);

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.commandName);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetOn.bind(this))
      .onGet(this.handleGetOn.bind(this));
  }

  private async handleSetOn(value: CharacteristicValue): Promise<void> {
    if (value as boolean) {
      this.platform.log.info(
        `${this.commandName} -> 0x${this.commandCode.toString(16).padStart(2, '0')}`,
      );

      try {
        await this.platform.transmitter.sendCommand(this.commandCode);
      } catch (e) {
        this.platform.log.error(`Failed to send ${this.commandName}: ${e}`);
      }

      // Auto-reset to OFF after 500ms (momentary button behavior)
      setTimeout(() => {
        this.service.updateCharacteristic(this.platform.Characteristic.On, false);
      }, 500);
    }
  }

  private handleGetOn(): CharacteristicValue {
    // CompuLink is one-way - no state feedback. Always report OFF.
    return false;
  }
}
