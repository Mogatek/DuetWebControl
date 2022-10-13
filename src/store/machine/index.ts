import ObjectModel, { GCodeFileInfo, initObject, MachineStatus, MessageType, Plugin } from "@duet3d/objectmodel";
import Vue from "vue";
import { Module } from "vuex";

import BaseConnector, { CancellationToken, FileListItem } from "./connector/BaseConnector";
import cache, { MachineCacheState } from "./cache";
import model from "./model";
import settings, { MachineSettingsState } from "./settings";

import packageInfo from "../../../package.json";
import i18n from "@/i18n";
import Root from "@/main";
import Plugins, { checkManifest, checkVersion, loadDwcResources } from "@/plugins";
import beep from "@/utils/beep";
import { displayTime } from "@/utils/display";
import { DisconnectedError, CodeBufferError, InvalidPasswordError, OperationCancelledError, OperationFailedError, FileNotFoundError } from "@/utils/errors";
import Events from "@/utils/events";
import { log, logCode, LogType } from "@/utils/logging";
import { makeFileTransferNotification, Notification, showMessage, FileTransferType } from "@/utils/notifications";
import Path from "@/utils/path";

import { RootState } from "..";

/**
 * Virtual hostname for the default module holding UI defaults.
 * It must not be a valid hostname to avoid potential conflicts
 */
export const defaultMachine = "[default]";

/**
 * Recorded machine event (e.g. message or code reply)
 */
export interface MachineEvent {
	/**
	 * Datetime of this event
	 */
	date: Date;

	/**
	 * Type of this event
	 */
	type: LogType;

	/**
	 * Title of this event
	 */
	title: string;

	/**
	 * Optional message of this event
	 */
	message: string | null;
}

/**
 * State of the machine module
 */
export interface MachineState {
	/**
	 * List of recorded events (items for the G-code console)
	 */
	 events: Array<MachineEvent>;

	 /**
	  * Indicates if the machine is attempting to reconnect
	  */
	 isReconnecting: boolean;

	 /**
	  * List of files currently being modified by a file operation
	  */
	 filesBeingChanged: Array<string>;

	 /**
	  * Indicates if multiple files are being transferred at once
	  */
	 transferringFiles: boolean;
}

/**
 * Interface for file transfer items
 */
export interface FileTransferItem {
	/**
	 * Filename of the element being transferred
	 */
	filename: string;

	/**
	 * Transferred content
	 */
	content: any;

	/**
	 * Expected respones type (if this is a download)
	 */
	type?: XMLHttpRequestResponseType;

	/**
	 * Time at which the transfer was started or null if it hasn"t started yet
	 */
	startTime: Date | null;

	/**
	 * How many times this upload has been restarted
	 */
	retry: number;

	/**
	 * Current progress
	 */
	progress: number;

	/**
	 * Speed (in bytes/sec)
	 */
	speed: number | null;

	/**
	 * Size of the item to transfer or null if unknown
	 */
	size: number | null;

	/**
	 * If present this holds the error causing the transfer to fail
	 */
	error?: any;
}

/**
 * Actual state of a machine state
 */
export interface MachineModuleState extends MachineState {
    cache: MachineCacheState;
    model: ObjectModel;
    settings: MachineSettingsState;
}

/**
 * Type of a Vuex machine module
 */
export type MachineModule = Module<MachineState, RootState>;

/**
 * Generate a new machine module instance
 * @param connector Connector used by the machine instance
 * @returns Machine module instance
 */
export default function(connector: BaseConnector | null): MachineModule {
	return {
		namespaced: true,
		state: {
			events: [],
			isReconnecting: false,
			filesBeingChanged: [],
			transferringFiles: false
		},
		getters: {
			/**
			 * Get the connector instance used to communicate with the remote machine (if available).
			 * This must remain a getter to prevent Vue from turning the connector into an observable!
			 * @returns Machine connector instance
			 */
			connector: () => connector,

			/**
			 * Indicates if there are any sensor values that can be displayed
			 */
			hasTemperaturesToDisplay: (state) => (state as MachineModuleState).model.sensors.analog.some(function (sensor, sensorIndex) {
				return ((state as MachineModuleState).model.heat.heaters.some(heater => heater && heater.sensor === sensorIndex) ||
						(state as MachineModuleState).settings.displayedExtraTemperatures.indexOf(sensorIndex) !== -1);
			})
		},
		actions: {
			/**
			 * Disconnect gracefully from this machine
			 */
			async disconnect(): Promise<void> {
				if (connector === null) { throw new OperationFailedError("disconnect is not available in default machine module"); }
				await connector.disconnect();
			},

			/**
			 * Reconnect after a connection error
			 */
			async reconnect({ state, commit, dispatch }) {
				if (connector === null) { throw new OperationFailedError("reconnect is not available in default machine module"); }

				if (!state.isReconnecting) {
					// Clear the global variables again and set the state to disconnected
					dispatch("update", {
						global: null,
						state: {
							status: MachineStatus.disconnected
						}
					});
				}

				commit("setReconnecting", true);
				try {
					await connector.reconnect();
					commit("setReconnecting", false);
					log(LogType.success, i18n.t("events.reconnected"));
				} catch (e) {
					console.warn(e);
					dispatch("onConnectionError", e);
				}
			},

			/**
			 * Send a code and log the result (if applicable)
			 * @param payload Can be either a string (code to send) or an object
			 * @param payload.code Code to send
			 * @param payload.fromInput Optional value indicating if the code originates from a code input (defaults to false)
			 * @param payload.log Log the code result (defaults to true)
			 * @param payload.noWait Do not wait for the code to complete (defaults to false)
			 */
			async sendCode(_, payload) {
				if (connector === null) { throw new OperationFailedError("sendCode is not available in default machine module"); }

				const code = (payload instanceof Object) ? payload.code : payload;
				const fromInput = (payload instanceof Object && payload.fromInput !== undefined) ? Boolean(payload.fromInput) : false;
				const doLog = (payload instanceof Object && payload.log !== undefined) ? Boolean(payload.log) : true;
				const noWait = (payload instanceof Object && payload.log !== undefined) ? Boolean(payload.noWait) : false;
				try {
					const reply = await connector.sendCode(code, noWait);
					if (doLog && (fromInput || reply !== "")) {
						logCode(code, reply as string, connector.hostname);
					}
					Root.$emit(Events.codeExecuted, { machine: connector.hostname, code, reply });
					return reply;
				} catch (e) {
					if (!(e instanceof DisconnectedError) && doLog) {
						const type = (e instanceof CodeBufferError) ? LogType.warning : LogType.error;
						log(type, code, e as string, connector.hostname);
					}
					throw e;
				}
			},

			/**
			 * Upload one or more files
			 * @param context Action context
			 * @param payload Action payload
			 * @param payload.filename Name of the file to upload (for single uploads)
			 * @param payload.content Content of the file to upload (for single uploads)
			 * @param payload.files List of files to upload (for combined multiple uploads)
			 * @param payload.showProgress Display upload progress (defaults to true)
			 * @param payload.showSuccess Show notification upon successful uploads (for single uploads, defaults to true)
			 * @param payload.showError Show notification upon error (defaults to true)
			 * @param payload.closeProgressOnSuccess Automatically close the progress indicator when finished (defaults to false)
			 */
			async upload({ commit, state }, payload) {
				if (connector === null) { throw new OperationFailedError("upload is not available in default machine module"); }

				const files = Vue.observable(new Array<FileTransferItem>()), cancellationToken: CancellationToken = { cancel() {} };
				const showProgress = (payload.showProgress !== undefined) ? Boolean(payload.showProgress) : true;
				const showSuccess = (payload.showSuccess !== undefined) ? Boolean(payload.showSuccess) : true;
				const showError = (payload.showError !== undefined) ? Boolean(payload.showError) : true;
				const closeProgressOnSuccess = (payload.closeProgressOnSuccess !== undefined) ? Boolean(payload.closeProgressOnSuccess) : false;

				// Prepare the arguments and tell listeners that an upload is about to start
				let notification: Notification | null = null;
				if (payload.filename) {
					files.push({
						filename: payload.filename,
						content: payload.content,
						startTime: null,
						retry: 0,
						progress: 0,
						speed: null,
						size: payload.content.length || payload.content.size || 0,
						error: null
					});
					commit("addFileBeingChanged", payload.filename);
					if (showProgress) {
						notification = makeFileTransferNotification(FileTransferType.upload, payload.filename, cancellationToken);
					}

					Root.$emit(Events.fileUploading, {
						machine: connector.hostname,
						filename: payload.filename,
						content: payload.content,
						showProgress,
						showSuccess,
						showError,
						cancellationToken
					});
				} else {
					if (state.transferringFiles) {
						throw new Error("Cannot perform two multi-file transfers at the same time");
					}
					commit("setMultiFileTransfer", true);

					for (const file of payload.files) {
						files.push({
							filename: file.filename,
							content: file.content,
							startTime: null,
							retry: 0,
							progress: 0,
							speed: null,
							size: file.content.length || file.content.size || 0,
							error: null
						});
						commit("addFileBeingChanged", file.filename);
					}

					Root.$emit(Events.multipleFilesUploading, {
						machine: connector.hostname,
						files,
						showProgress,
						closeProgressOnSuccess,
						cancellationToken
					});
				}

				// Upload the file(s)
				try {
					for (let i = 0; i < files.length; i++) {
						const item = files[i], filename = item.filename, content = item.content;
						try {
							// Check if config.g needs to be backed up
							const configFile = Path.combine((state as MachineModuleState).model.directories.system, Path.configFile);
							if (Path.equals(filename, configFile)) {
								const configFileBackup = Path.combine((state as MachineModuleState).model.directories.system, Path.configBackupFile);
								try {
									await connector.move(configFile, configFileBackup, true);
								} catch (e) {
									if (!(e instanceof OperationFailedError) && !(e instanceof FileNotFoundError)) {
										// config.g may not exist, so suppress errors if necessary
										throw e;
									}
								}
							}

							// Clear the cached file info (if any)
							commit("cache/clearFileInfo", filename);

							// Wait for the upload to finish
							item.startTime = new Date();
							await connector.upload(
								filename,
								content,
								cancellationToken,
								(loaded, total, retry) => {
									if (item.startTime === null) {
										item.startTime = new Date();
									}
									item.progress = loaded / total;
									item.speed = loaded / (((new Date()).getTime() - item.startTime.getTime()) / 1000);
									item.retry = retry;
									if (notification && notification.onProgress) {
										notification.onProgress(loaded, total, item.speed);
									}
								}
							);
							item.progress = 1;

							// Show success message
							if (payload.filename && showSuccess) {
								const secondsPassed = Math.round(((new Date()).getTime() - item.startTime.getTime()) / 1000);
								log(LogType.success, i18n.t("notification.upload.success", [Path.extractFileName(filename), displayTime(secondsPassed)]), undefined, connector.hostname);
							}

							// File has been uploaded successfully, emit an event
							Root.$emit(Events.fileUploaded, {
								machine: connector.hostname,
								filename,
								content,
								num: i,
								count: files.length
							});
						} catch (e) {
							// Failed to upload a file, emit an event
							Root.$emit(Events.fileUploadError, {
								machine: connector.hostname,
								filename,
								content,
								error: e
							});

							// Show an error if requested
							if (showError && !(e instanceof OperationCancelledError)) {
								console.warn(e);
								log(LogType.error, i18n.t("notification.upload.error", [Path.extractFileName(filename)]), e as string, connector.hostname);
							}

							// Rethrow the error so the caller is notified
							item.error = e;
							throw e;
						}
					}
				} finally {
					if (notification) {
						notification.close();
					}
					commit("clearFilesBeingChanged");
					if (!payload.filename) {
						commit("setMultiFileTransfer", false);
					}
					Root.$emit(Events.filesOrDirectoriesChanged, {
						machine: connector.hostname,
						files: files.map(file => file.filename)
					});
				}
			},

			/**
			 * Delete a file or directory
			 * @param context Action context
			 * @param filename Filename to delete
			 */
			async delete(context, filename) {
				if (connector === null) { throw new OperationFailedError("delete is not available in default machine module"); }

				await connector.delete(filename);
				Root.$emit(Events.fileOrDirectoryDeleted, { machine: connector.hostname, filename });
				Root.$emit(Events.filesOrDirectoriesChanged, { machine: connector.hostname, files: [filename] });
			},

			/**
			 * 
			 * @param context Action context
			 * @param payload Action payload
			 * @param payload.from File or directory to move
			 * @param payload.to New filename of the file or directory
			 * @param payload.force Overwrite existing files (defaults to false)
			 */
			async move(context, { from, to, force = false }) {
				if (connector === null) { throw new OperationFailedError("delete is not available in default machine module"); }

				await connector.move(from, to, force);
				Root.$emit(Events.fileOrDirectoryMoved, { machine: connector.hostname, from, to, force });
				Root.$emit(Events.filesOrDirectoriesChanged, { machine: connector.hostname, files: [from, to] });
			},

			/**
			 * Make a new directory
			 * @param context Action context
			 * @param directory Directory path to create 
			 */
			async makeDirectory(context, directory) {
				if (connector === null) { throw new OperationFailedError("delete is not available in default machine module"); }

				await connector.makeDirectory(directory);
				Root.$emit(Events.directoryCreated, { machine: connector.hostname, directory });
				Root.$emit(Events.filesOrDirectoriesChanged, { machine: connector.hostname, files: [directory] });
			},

			/**
			 * Download one or more files
			 * @param context Action context
			 * @param payload Action payload
			 * @param payload.filename Name of the file to download (for single transfers)
			 * @param payload.type Data type of the file to download (for single transfers)
			 * @param payload.files List of files to download (for multiple transfers)
			 * @param payload.showProgress Display upload progress (defaults to true)
			 * @param payload.showSuccess Show notification upon successful uploads (for single uploads, defaults to true)
			 * @param payload.showError Show notification upon error (defaults to true)
			 * @param payload.closeProgressOnSuccess Automatically close the progress indicator when finished (defaults to false)
			 * @returns File transfer item if a single file was requested, else the files list plus content property
			 */
			async download(context, payload): Promise<FileTransferItem | Array<FileTransferItem>> {
				if (connector === null) { throw new OperationFailedError("download is not available in default machine module"); }

				const files = Vue.observable(new Array<FileTransferItem>), cancellationToken: CancellationToken = { cancel() { } };
				const showProgress = (payload.showProgress !== undefined) ? Boolean(payload.showProgress) : true;
				const showSuccess = (payload.showSuccess !== undefined) ? Boolean(payload.showSuccess) : true;
				const showError = (payload.showError !== undefined) ? Boolean(payload.showError) : true;
				const closeProgressOnSuccess = (payload.closeProgressOnSuccess !== undefined) ? Boolean(payload.closeProgressOnSuccess) : false;

				// Prepare the arguments and tell listeners that an upload is about to start
				let notification: Notification | null = null;
				if (payload.filename) {
					files.push({
						filename: payload.filename,
						content: null,
						type: payload.type || "json",
						startTime: null,
						retry: 0,
						progress: 0,
						speed: null,
						size: null,
						error: null
					});
					if (showProgress) {
						notification = makeFileTransferNotification(FileTransferType.download, payload.filename, cancellationToken);
					}

					Root.$emit(Events.fileDownloading, {
						machine: connector.hostname,
						filename: payload.filename,
						type: payload.type,
						showProgress,
						showSuccess,
						showError,
						cancellationToken
					});
				} else {
					if (context.state.transferringFiles) {
						throw new Error("Cannot perform two multi-file transfers at the same time");
					}
					context.commit("setMultiFileTransfer", true);

					for (const file of payload.files) {
						files.push({
							filename: file.filename,
							content: null,
							type: file.type || "blob",
							startTime: null,
							retry: 0,
							progress: 0,
							speed: null,
							size: null,
							error: null
						});
					}

					Root.$emit(Events.multipleFilesDownloading, {
						machine: connector.hostname,
						files,
						showProgress,
						closeProgressOnSuccess,
						cancellationToken
					});
				}

				// Download the file(s)
				try {
					for (let i = 0; i < files.length; i++) {
						const item = files[i], filename = item.filename, type = item.type;
						try {
							// Wait for download to finish
							item.startTime = new Date();
							const response = await connector.download(
								filename,
								type,
								cancellationToken,
								(loaded, total, retry) => {
									if (item.startTime === null) {
										item.startTime = new Date();
									}
									item.size = total;
									item.progress = loaded / total;
									item.speed = loaded / (((new Date()).getTime() - item.startTime.getTime()) / 1000);
									item.retry = retry;
									if (notification && notification.onProgress) {
										notification.onProgress(loaded, total, item.speed);
									}
								}
							);
							item.progress = 1;

							// Show success message
							if (payload.filename && showSuccess) {
								const secondsPassed = Math.round(((new Date()).getTime() - item.startTime.getTime()) / 1000);
								log(LogType.success, i18n.t("notification.download.success", [Path.extractFileName(filename), displayTime(secondsPassed)]), undefined, connector.hostname);
							}

							// File has been uploaded successfully, emit an event
							Root.$emit(Events.fileDownloaded, {
								machine: connector.hostname,
								filename,
								type,
								num: i,
								count: files.length
							});

							// Return the response if a single file was requested
							if (payload.filename) {
								return response;
							}
							item.content = response;
						} catch (e) {
							// Failed to download a file, emit an event
							Root.$emit(Events.fileDownloadError, {
								machine: connector.hostname,
								filename,
								type,
								error: e
							});

							// Show an error if requested
							if (showError && !(e instanceof OperationCancelledError)) {
								console.warn(e);
								log(LogType.error, i18n.t("notification.download.error", [Path.extractFileName(filename)]), e as string, connector.hostname);
							}

							// Rethrow the error so the caller is notified
							item.error = e;
							throw e;
						}
					}
				} finally {
					if (notification) {
						notification.close();
					}
					if (!payload.filename) {
						context.commit("setMultiFileTransfer", false);
					}
				}
				return payload.filename ? files[0] : files;
			},

			/**
			 * List the files and directories from a given directory
			 * @param context Action context
			 * @param directory Directory to query
			 */
			async getFileList(context, directory: string): Promise<Array<FileListItem>> {
				if (connector === null) { throw new OperationFailedError("getFileList is not available in default machine module"); }
				return connector.getFileList(directory);
			},

			/**
			 * Parse a G-code file and return the retrieved information
			 * @param context Action context
			 * @param payload Action payload
			 * @param payload.filename Path of the file to parse
			 * @param payload.readThumbnailContent Retrieve thumbnail contents (defaults to false)
			 */
			async getFileInfo(context, { filename, readThumbnailContent }): Promise<GCodeFileInfo> {
				if (connector === null) { throw new OperationFailedError("getFileInfo is not available in default machine module"); }
				return connector.getFileInfo(filename, readThumbnailContent);
			},

			/**
			 * Install or upgrade a third-party plugin
			 * @param context Action context
			 * @param payload Action payload
			 * @param payload.zipFilename Filename of the ZIP container
			 * @param payload.zipBlob ZIP container data to upload (if applicable)
			 * @param payload.zipFile ZIP container to extract (if applicable)
			 * @param payload.start Whether to start the plugin upon installation
			 */
			async installPlugin({ dispatch }, { zipFilename, zipBlob, zipFile, start }) {
				if (connector === null) { throw new OperationFailedError("installPlugin is not available in default machine module"); }

				// Check the required DWC version
				const manifestJson = JSON.parse(await zipFile.file("plugin.json").async("string"));
				const plugin = initObject(Plugin, manifestJson);

				// Check plugin manifest
				if (!checkManifest(plugin)) {
					throw new Error("Invalid plugin manifest");
				}

				// Is the plugin compatible to the running DWC version?
				if (plugin.dwcVersion && !checkVersion(plugin.dwcVersion, packageInfo.version)) {
					throw new Error(`Plugin ${plugin.id} requires incompatible DWC version (need ${plugin.dwcVersion}, got ${packageInfo.version})`);
				}

				// Install the plugin
				await connector.installPlugin(
					zipFilename,
					zipBlob,
					zipFile,
					plugin,
					start
				);

				// Start it if required and show a message
				if (start) {
					await dispatch("loadDwcPlugin", { id: plugin.id, saveSettings: true });
				}
			},

			/**
			 * Uninstall a third-party plugin
			 * @param context Action context
			 * @param plugin Plugin instance to uninstall
			 */
			async uninstallPlugin(context, plugin): Promise<void> {
				if (connector === null) { throw new OperationFailedError("uninstallPlugin is not available in default machine module"); }
				await connector.uninstallPlugin(plugin);
			},

			/**
			 * Set custom plugin data on the SBC.
			 * This is only supported in SBC mode and if no SBC executable is part of the plugin (e.g. to share session-independent data).
			 * If there is an SBC executable, consider implementing your own HTTP endpoints and/or G/M-codes to avoid potential conflicts
			 * @param context Action context
			 * @param payload Action payload
			 * @param payload.plugin Identifier of the plugin
			 * @param payload.key Existing key of the plugin data to set
			 * @param payload.value Custom value to set
			 */
			async setSbcPluginData(context, { plugin, key, value }): Promise<void> {
				if (connector === null) { throw new OperationFailedError("setSbcPluginData is not available in default machine module"); }
				await connector.setSbcPluginData(plugin, key, value);
			},

			/**
			 * Start a plugin on the SBC
			 * @param context Action context
			 * @param plugin Identifier of the plugin
			 */
			async startSbcPlugin(context, plugin): Promise<void> {
				if (connector === null) { throw new OperationFailedError("startSbcPlugin is not available in default machine module"); }
				await connector.startSbcPlugin(plugin);
			},

			/**
			 * Stop a plugin on the SBC
			 * @param context Action context
			 * @param plugin Identifier of the plugin
			 */
			async stopSbcPlugin(context, plugin): Promise<void> {
				if (connector === null) { throw new OperationFailedError("stopSbcPlugin is not available in default machine module"); }
				await connector.stopSbcPlugin(plugin);
			},

			/**
			 * Install a system package file on the SBC (deb files on DuetPi).
			 * Since this is a potential security hazard, this call is only supported if the DSF is configured to permit system package installations
			 * @param context Action context
			 * @param payload Action payload
			 * @param payload.filename Name of the package file
			 * @param payload.packageData Blob data of the package to install 
			 * @param payload.cancellationToken Optional cancellation token that may be triggered to cancel this operation
			 * @param payload.onProgress Optional callback for progress reports
			 */
			async installSystemPackage(context, { filename, packageData, cancellationToken, onProgress }): Promise<void> {
				if (connector === null) { throw new OperationFailedError("installSystemPackage is not available in default machine module"); }
				await connector.installSystemPackage(filename, packageData, cancellationToken, onProgress);
			},

			/**
			 * Uninstall a system package from the SBC.
			 * Since this is a potential security hazard, this call is only supported if the DSF is configured to permit system package installations
			 * @param context Action context
			 * @param pkg Name of the package to uninstall
			 */
			async uninstallSystemPackage(context, pkg): Promise<void> {
				if (connector === null) { throw new OperationFailedError("uninstallSystemPackage is not available in default machine module"); }
				await connector.uninstallSystemPackage(pkg);
			},

			/**
			 * Load a DWC plugin from this machine
			 * @param context Action context
			 * @param payload Action payload
			 * @param payload.id Plugin identifier
			 * @param payload.saveSettings Save settings (including enabled plugins) when the plugin has been successfully loaded
			 */
			async loadDwcPlugin({ rootState, state, dispatch, commit }, { id, saveSettings }) {
				if (connector === null) { throw new OperationFailedError("loadDwcPlugin is not available in default machine module"); }
				const machineState = state as MachineModuleState;

				// Don"t load a DWC plugin twice
				if (rootState.loadedDwcPlugins.indexOf(id) !== -1) {
					return;
				}

				// Get the plugin
				const plugin = machineState.model.plugins.get(id);
				if (!plugin) {
					if (saveSettings) {
						throw new Error(`Plugin ${id} not found`);
					}

					// Fail silently if the config is being loaded
					console.warn(`Plugin ${id} not found`);
					return;
				}

				// Check if there are any resources to load and if it is actually possible
				if (!plugin.dwcFiles.some(file => file.indexOf(plugin.id) !== -1 && /\.js$/.test(file)) || process.env.NODE_ENV === "development") {
					return;
				}

				// Check if the requested webpack chunk is already part of a built-in plugin
				if (Plugins.some(item => item.id === plugin.id)) {
					throw new Error(`Plugin ${id} cannot be loaded because the requested Webpack file is already reserved by a built-in plugin`);
				}

				// Check if the corresponding SBC plugin has been loaded (if applicable)
				if (plugin.sbcRequired) {
					if (!machineState.model.state.dsfVersion ||
						(plugin.sbcDsfVersion && !checkVersion(plugin.sbcDsfVersion, machineState.model.state.dsfVersion)))
					{
						throw new Error(`Plugin ${id} cannot be loaded because the current machine does not have an SBC attached`);
					}
				}

				// Check if the RRF dependency could be fulfilled (if applicable)
				if (plugin.rrfVersion) {
					if (machineState.model.boards.length === 0 ||
						!checkVersion(plugin.rrfVersion, machineState.model.boards[0].firmwareVersion))
					{
						throw new Error(`Plugin ${id} could not fulfill RepRapFirmware version dependency (requires ${plugin.rrfVersion})`);
					}
				}

				// Is the plugin compatible to the running DWC version?
				if (plugin.dwcVersion && !checkVersion(plugin.dwcVersion, packageInfo.version)) {
					throw new Error(`Plugin ${id} requires incompatible DWC version (need ${plugin.dwcVersion}, got ${packageInfo.version})`);
				}

				// Load plugin dependencies in DWC
				for (const dependency of plugin.dwcDependencies) {
					const dependentPlugin = machineState.model.plugins.get(dependency);
					if (!dependentPlugin) {
						throw new Error(`Failed to find DWC plugin dependency ${dependency} for plugin ${plugin.id}`);
					}

					if (!rootState.loadedDwcPlugins.includes(dependency)) {
						await dispatch("loadDwcPlugin", { id: dependency, saveSettings: false });
					}
				}

				// Load the required web module
				await loadDwcResources(plugin);

				// DWC plugin has been loaded
				commit("dwcPluginLoaded", plugin.id, { root: true });
				if (saveSettings) {
					commit("settings/dwcPluginLoaded", plugin.id);
				}
			},

			/**
			 * Unload a DWC plugin. This does not remove running code but marks the plugin to be skipped upon reload
			 * @param context Action context
			 * @param plugin Identifier of the plugin to unload
			 */
			async unloadDwcPlugin({ dispatch, commit }, plugin) {
				commit("settings/disableDwcPlugin", plugin);
				await dispatch("settings/save");
			},

			/**
			 * Update the machine"s object model. This must be used by connectors only!
			 * @param context Action context
			 * @param payload Updated model data
			 */
			async update({ state, commit }, payload) {
				const machineState = state as MachineModuleState;

				const lastBeepFrequency = machineState.model.state.beep ? machineState.model.state.beep.frequency : null;
				const lastBeepDuration = machineState.model.state.beep ? machineState.model.state.beep.duration : null;
				const lastDisplayMessage = machineState.model.state.displayMessage;
				const lastStatus = machineState.model.state.status;

				// Check if the job has finished and if so, clear the file cache
				if (payload.job && payload.job.lastFileName && payload.job.lastFileName !== machineState.model.job.lastFileName) {
					commit("cache/clearFileInfo", payload.job.lastFileName);
				}

				// Deal with incoming messages
				if (payload.messages) {
					for (const message of payload.messages) {
						let reply;
						switch (message.type) {
							case MessageType.warning:
								reply = `Warning: ${message.content}`;
								break;
							case MessageType.error:
								reply = `Error: ${message.content}`;
								break;
							default:
								reply = message.content;
								break;
						}
						logCode(null, reply, connector ? connector.hostname : defaultMachine);
						Root.$emit(Events.codeExecuted, {
							machine: connector ? connector.hostname : defaultMachine,
							code: null,
							reply
						});
					}
					delete payload.messages;
				}

				// Merge updates into the object model
				commit("model/update", payload);
				Root.$emit(Events.machineModelUpdated, connector ? connector.hostname : defaultMachine);
				
				// Is a new beep requested?
				if (machineState.model.state.beep &&
					lastBeepDuration !== machineState.model.state.beep.duration &&
					lastBeepFrequency !== machineState.model.state.beep.frequency) {
					beep(machineState.model.state.beep.frequency, machineState.model.state.beep.duration);
				}

				// Is a new message supposed to be shown?
				if (machineState.model.state.displayMessage !== lastDisplayMessage) {
					showMessage(machineState.model.state.displayMessage);
				}

				// Has the firmware halted?
				if (lastStatus !== machineState.model.state.status && machineState.model.state.status === MachineStatus.halted) {
					log(LogType.warning, i18n.t("events.emergencyStop"));
				}
			},

			/**
			 * Event to be called by a connector on connection error.
			 * This makes sure that the connector attempts to reconnect in certain intervals
			 * @param context Action context
			 * @param error Error causing the connection to be interrupted
			 */
			async onConnectionError({ state, dispatch }, error) {
				if (connector === null) { throw new OperationFailedError("onConnectionError is not available in default machine module"); }
				const machineState = state as MachineModuleState;
				console.warn(error);

				if (state.isReconnecting && !(error instanceof InvalidPasswordError)) {
					// Retry after a short moment
					setTimeout(() => dispatch("reconnect", 2000));
				} else if (!state.isReconnecting && (machineState.model.state.status === MachineStatus.updating || machineState.model.state.status === MachineStatus.halted)) {
					// Try to reconnect
					if (machineState.model.state.status !== MachineStatus.updating) {
						log(LogType.warning, i18n.t("events.reconnecting"));
					}
					await dispatch("reconnect");
				} else {
					// Notify the root store about this event
					await dispatch("onConnectionError", { hostname: connector.hostname, error }, { root: true });
				}
			}
		},
		mutations: {
			/**
			 * Mark a file as being modified to
			 * @param state Vuex state
			 * @param filename Name of the file being modified
			 */
			addFileBeingChanged(state, filename) {
				state.filesBeingChanged.push(filename);
			},

			/**
			 * Clear the list of files being changed
			 * @param state Vuex state
			 */
			clearFilesBeingChanged(state) {
				state.filesBeingChanged = [];
			},

			/**
			 * Flag if multiple files are being transferred
			 * @param state Vuex state
			 * @param transferring Whether multiple files are being transferred
			 */
			setMultiFileTransfer(state, transferring) {
				state.transferringFiles = transferring;
			},

			/**
			 * Clear all logged events
			 * @param state Vuex state
			 */
			clearLog: state => state.events = [],

			/**
			 * Log a custom event
			 * @param state Vuex state
			 * @param payload Machine event to log
			 */
			log: (state, payload) => state.events.push(payload),

			/**
			 * Notify the machine connector that the module is about to be unregistered from Vuex
			 */
			unregister: () => connector?.unregister(),

			/**
			 * Flag if the machine is attempting to reconnect
			 * @param state Vuex state
			 * @param reconnecting Whether the machine is attempting to reconnect
			 */
			setReconnecting: (state, reconnecting) => state.isReconnecting = reconnecting
		},
		modules: {
			cache: cache(connector),
			model: model(connector),
			settings: settings(connector)
		}
	}
}