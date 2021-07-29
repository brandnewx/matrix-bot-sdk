import { MatrixClient } from "../MatrixClient";
import { LogService } from "../logging/LogService";
import { DeviceKeyAlgorithm, UserDevice } from "../models/Crypto";

/**
 * Tracks user devices for encryption operations.
 * @category Encryption
 */
export class DeviceTracker {
    private deviceListUpdates: Record<string, Promise<void>> = {};

    public constructor(private client: MatrixClient) {
    }

    /**
     * Flags multiple user's device lists as outdated, optionally queuing an immediate update.
     * @param {string} userIds The user IDs to flag the device lists of.
     * @param {boolean} resync True (default) to queue an immediate update, false otherwise.
     */
    public async flagUsersOutdated(userIds: string[], resync = true) {
        await this.client.cryptoStore.flagUsersOutdated(userIds);
        if (resync) {
            // We don't really want to wait around for this, so let it work in the background
            // noinspection ES6MissingAwait
            this.updateUsersDeviceLists(userIds);
        }
    }

    /**
     * Updates multiple user's device lists regardless of outdated flag.
     * @param {string[]} userIds The user IDs to update.
     * @returns {Promise<void>} Resolves when complete.
     */
    public async updateUsersDeviceLists(userIds: string[]): Promise<void> {
        // We wait for the lock, but still run through with our update just in case we are lagged.
        // This can happen if the server is slow to reply to device list queries, but a user is
        // changing information about their device a lot.
        const existingPromises = userIds.map(u => this.deviceListUpdates[u]).filter(p => !!p);
        if (existingPromises.length > 0) {
            await Promise.all(existingPromises);
        }

        const promise = new Promise<void>(async resolve => {
            const resp = await this.client.getUserDevices(userIds);
            for (const userId of Object.keys(resp.device_keys)) {
                const validated: UserDevice[] = [];
                for (const deviceId of Object.keys(resp.device_keys[userId])) {
                    const device = resp.device_keys[userId][deviceId];
                    if (device.user_id !== userId || device.device_id !== deviceId) {
                        LogService.warn("DeviceTracker", `Server appears to be lying about device lists: ${userId} ${deviceId} has unexpected device ${device.user_id} ${device.device_id} listed - ignoring device`);
                        continue;
                    }

                    const ed25519 = device.keys[`${DeviceKeyAlgorithm.Ed25119}:${deviceId}`];
                    const curve25519 = device.keys[`${DeviceKeyAlgorithm.Curve25519}:${deviceId}`];

                    if (!ed25519 || !curve25519) {
                        LogService.warn("DeviceTracker", `Device ${userId} ${deviceId} is missing either an Ed25519 or Curve25519 key - ignoring device`);
                        continue;
                    }

                    const currentDevices = await this.client.cryptoStore.getUserDevices(userId);
                    const existingDevice = currentDevices.find(d => d.device_id === deviceId);

                    if (existingDevice) {
                        const existingEd25519 = existingDevice.keys[`${DeviceKeyAlgorithm.Ed25119}:${deviceId}`];
                        if (existingEd25519 !== ed25519) {
                            LogService.warn("DeviceTracker", `Device ${userId} ${deviceId} appears compromised: Ed25519 key changed - ignoring device`);
                            continue;
                        }
                    }

                    const signature = device.signatures?.[userId]?.[`${DeviceKeyAlgorithm.Ed25119}:${deviceId}`];
                    if (!signature) {
                        LogService.warn("DeviceTracker", `Device ${userId} ${deviceId} is missing a signature - ignoring device`);
                        continue;
                    }

                    const validSignature = await this.client.crypto.verifySignature(device, ed25519, signature);
                    if (!validSignature) {
                        LogService.warn("DeviceTracker", `Device ${userId} ${deviceId} has an invalid signature - ignoring device`);
                        continue;
                    }

                    validated.push(device);
                }

                await this.client.cryptoStore.setUserDevices(userId, validated);
            }
            resolve();
        });
        userIds.forEach(u => this.deviceListUpdates[u] = promise);
        await promise;
    }
}
