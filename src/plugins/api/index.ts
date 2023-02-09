import { store } from "../store";
/* eslint-disable no-constant-condition */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-unused-vars */
import {
  WebsocketBuilder,
  Websocket,
  WebsocketEvents,
  LinearBackoff,
} from "websocket-ts";
import { reactive, ref } from "vue";
import {
  type Connection,
  createConnection,
  ERR_HASS_HOST_REQUIRED,
  getAuth,
} from "home-assistant-js-websocket";

import {
  type Artist,
  type Album,
  type Track,
  type Radio,
  type Playlist,
  type Player,
  type PlayerQueue,
  type PagedItems,
  type MediaItemType,
  type MediaType,
  type BrowseFolder,
  type QueueItem,
  QueueOption,
  type ProviderInstance,
  type MassEvent,
  EventType,
  type EventMessage,
  type ServerInfoMessage,
  type SuccessResultMessage,
  type ErrorResultMessage,
  type CommandMessage,
} from "./interfaces";

const DEBUG = true;

export interface Library {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
  radios: Radio[];
  playlists: Playlist[];
  artistsFetched: boolean;
  albumsFetched: boolean;
  tracksFetched: boolean;
  radiosFetched: boolean;
  playlistsFetched: boolean;
}

export enum ConnectionState {
  DISCONNECTED = 0,
  CONNECTING = 1,
  CONNECTED = 2,
}

export class MusicAssistantApi {
  // eslint-disable-next-line prettier/prettier
  private ws?: Websocket;
  private commandId: number;
  private _throttleId?: any;
  public baseUrl?: string;
  public state = ref<ConnectionState>(ConnectionState.DISCONNECTED);
  public serverInfo = ref<ServerInfoMessage>();
  public players = reactive<{ [player_id: string]: Player }>({});
  public queues = reactive<{ [queue_id: string]: PlayerQueue }>({});
  public providers = reactive<ProviderInstance[]>([]);
  private eventCallbacks: Array<[string, CallableFunction]>;
  private commands: Map<
    number,
    {
      resolve: (result?: any) => void;
      reject: (err: any) => void;
    }
  >;

  constructor() {
    this.commandId = 0;
    this.eventCallbacks = [];
    this.commands = new Map();
  }

  public async initialize(baseUrl: string) {
    if (this.ws) throw "already initialized";
    if (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
    this.baseUrl = baseUrl;
    const wsUrl = baseUrl.replace("http", "ws") + "/ws";
    console.log(`Connecting to Music Assistant API ${wsUrl}`);
    this.state.value = ConnectionState.CONNECTING;
    // connect to the websocket api
    this.ws = new WebsocketBuilder(wsUrl)
      .onOpen((i, ev) => {
        console.log("connection opened");
      })
      .onClose((i, ev) => {
        console.log("connection closed");
        this.state.value = ConnectionState.DISCONNECTED;
      })
      .onError((i, ev) => {
        console.log("error on connection");
      })
      .onMessage((i, ev) => {
        // Message retrieved on the websocket
        var msg = JSON.parse(ev.data);
        if ("event" in msg) {
          this.handleEventMessage(msg as EventMessage);
        } else if ("server_version" in msg) {
          this.handleServerInfoMessage(msg as ServerInfoMessage);
        } else if ("message_id" in msg) {
          this.handleResultMessage(msg);
        } else {
          // unknown message receoved
          console.error("received unknown message", msg);
        }
      })
      .onRetry((i, ev) => {
        console.log("retry");
        this.state.value = ConnectionState.CONNECTING;
      })
      .withBackoff(new LinearBackoff(0, 1000, 12000))
      .build();
  }

  public subscribe(eventFilter: EventType, callback: CallableFunction) {
    // subscribe a listener for events
    // returns handle to remove the listener
    const listener: [EventType, CallableFunction] = [eventFilter, callback];
    this.eventCallbacks.push(listener);
    const removeCallback = () => {
      const index = this.eventCallbacks.indexOf(listener);
      if (index > -1) {
        this.eventCallbacks.splice(index, 1);
      }
    };
    return removeCallback;
  }

  public subscribe_multi(
    eventFilters: EventType[],
    callback: CallableFunction
  ) {
    // subscribe a listener for multiple events
    // returns handle to remove the listener
    const removeCallbacks: CallableFunction[] = [];
    for (const eventFilter of eventFilters) {
      removeCallbacks.push(this.subscribe(eventFilter, callback));
    }
    const removeCallback = () => {
      for (const cb of removeCallbacks) {
        cb();
      }
    };
    return removeCallback;
  }

  public getProvider(
    provDomainOrInstance: string
  ): ProviderInstance | undefined {
    // Get provider by domain or instance id
    return this.providers.find(
      (x) =>
        x.domain == provDomainOrInstance ||
        x.instance_id == provDomainOrInstance
    );
  }

  public getTracks(
    in_library?: boolean,
    search?: string,
    limit?: number,
    offset?: number,
    order_by?: string
  ): Promise<PagedItems> {
    return this.getData("music/tracks", {
      in_library,
      search,
      limit,
      offset,
      order_by,
    });
  }

  public getTrack(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string,
    force_refresh?: boolean,
    lazy?: boolean,
    force_provider_item?: boolean
  ): Promise<Track> {
    return this.getData("music/track", {
      item_id,
      provider_domain,
      provider_instance,
      force_refresh,
      lazy,
      force_provider_item,
    });
  }

  public getTrackVersions(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string
  ): Promise<Track[]> {
    return this.getData("music/track/versions", {
      item_id,
      provider_domain,
      provider_instance,
    });
  }

  public getTrackPreviewUrl(
    provider_domain: string,
    item_id: string
  ): Promise<string> {
    return this.getData("music/track/preview", {
      provider_domain,
      item_id,
    });
  }

  public getArtists(
    in_library?: boolean,
    search?: string,
    limit?: number,
    offset?: number,
    order_by?: string
  ): Promise<PagedItems> {
    return this.getData("music/artists", {
      in_library,
      search,
      limit,
      offset,
      order_by,
    });
  }

  public getAlbumArtists(
    in_library?: boolean,
    search?: string,
    limit?: number,
    offset?: number,
    order_by?: string
  ): Promise<PagedItems> {
    return this.getData("music/albumartists", {
      in_library,
      search,
      limit,
      offset,
      order_by,
    });
  }

  public getArtist(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string,
    force_refresh?: boolean,
    lazy?: boolean,
    force_provider_item?: boolean
  ): Promise<Artist> {
    return this.getData("music/artist", {
      item_id,
      provider_domain,
      provider_instance,
      force_refresh,
      lazy,
      force_provider_item,
    });
  }

  public getArtistTracks(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string
  ): Promise<Track[]> {
    return this.getData("music/artist/tracks", {
      item_id,
      provider_domain,
      provider_instance,
    });
  }

  public getArtistAlbums(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string
  ): Promise<Album[]> {
    return this.getData("music/artist/albums", {
      item_id,
      provider_domain,
      provider_instance,
    });
  }

  public getAlbums(
    in_library?: boolean,
    search?: string,
    limit?: number,
    offset?: number,
    order_by?: string
  ): Promise<PagedItems> {
    return this.getData("music/albums", {
      in_library,
      search,
      limit,
      offset,
      order_by,
    });
  }

  public getAlbum(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string,
    force_refresh?: boolean,
    lazy?: boolean,
    force_provider_item?: boolean
  ): Promise<Album> {
    return this.getData("music/album", {
      item_id,
      provider_domain,
      provider_instance,
      force_refresh,
      lazy,
      force_provider_item,
    });
  }

  public getAlbumTracks(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string
  ): Promise<Track[]> {
    return this.getData("music/album/tracks", {
      item_id,
      provider_domain,
      provider_instance,
    });
  }

  public getAlbumVersions(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string
  ): Promise<Album[]> {
    return this.getData("music/album/versions", {
      item_id,
      provider_domain,
      provider_instance,
    });
  }

  public getPlaylists(
    in_library?: boolean,
    search?: string,
    limit?: number,
    offset?: number,
    order_by?: string
  ): Promise<PagedItems> {
    return this.getData("music/playlists", {
      in_library,
      search,
      limit,
      offset,
      order_by,
    });
  }

  public getPlaylist(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string,
    force_refresh?: boolean,
    lazy?: boolean,
    force_provider_item?: boolean
  ): Promise<Playlist> {
    return this.getData("music/playlist", {
      item_id,
      provider_domain,
      provider_instance,
      force_refresh,
      lazy,
      force_provider_item,
    });
  }

  public getPlaylistTracks(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string
  ): Promise<Track[]> {
    return this.getData("music/playlist/tracks", {
      item_id,
      provider_domain,
      provider_instance,
    });
  }

  public addPlaylistTracks(db_playlist_id: string | number, uris: string[]) {
    this.sendCommand("music/playlist/tracks/add", { db_playlist_id, uris });
  }

  public removePlaylistTracks(
    db_playlist_id: string | number,
    positions_to_remove: number[]
  ) {
    this.sendCommand("music/playlist/tracks/remove", {
      db_playlist_id,
      positions_to_remove,
    });
  }

  public createPlaylist(name: string, provider?: string): Promise<Playlist> {
    return this.getData("music/playlist/create", { name, provider });
  }

  public getRadios(
    in_library?: boolean,
    search?: string,
    limit?: number,
    offset?: number,
    order_by?: string
  ): Promise<PagedItems> {
    return this.getData("music/radios", {
      in_library,
      search,
      limit,
      offset,
      order_by,
    });
  }

  public getRadio(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string,
    force_refresh?: boolean,
    lazy?: boolean
  ): Promise<Radio> {
    return this.getData("music/radio", {
      item_id,
      provider_domain,
      provider_instance,
      force_refresh,
      lazy,
    });
  }

  public getRadioVersions(
    item_id: string,
    provider_domain?: string,
    provider_instance?: string
  ): Promise<Radio[]> {
    return this.getData("music/radio/versions", {
      item_id,
      provider_domain,
      provider_instance,
    });
  }

  public getItemByUri(
    uri: string,
    force_refresh?: boolean,
    lazy?: boolean
  ): Promise<MediaItemType> {
    // Get single music item providing a mediaitem uri.
    return this.getData("music/item_by_uri", {
      uri,
      force_refresh,
      lazy,
    });
  }

  public getItem(
    media_type: MediaType,
    item_id: string,
    provider_domain?: string,
    provider_instance?: string,
    force_refresh?: boolean,
    lazy?: boolean
  ): Promise<MediaItemType> {
    // Get single music item by id and media type.
    return this.getData("music/item", {
      media_type,
      item_id,
      provider_domain,
      provider_instance,
      force_refresh,
      lazy,
    });
  }

  public async addToLibrary(
    media_type: MediaType,
    item_id: string,
    provider_domain?: string,
    provider_instance?: string
  ) {
    // Add an item to the library.
    this.sendCommand("music/library/add", {
      media_type,
      item_id,
      provider_domain,
      provider_instance,
    });
  }
  public async addItemsToLibrary(items: Array<MediaItemType | string>) {
    // Add multiple items to the library (provide uri or MediaItem).
    this.sendCommand("music/library/add_items", { items });
    // optimistically set the value
    for (const item of items) {
      if (typeof item !== "string") {
        item.in_library = true;
      }
    }
  }

  public async removeFromLibrary(
    media_type: MediaType,
    item_id: string,
    provider_domain?: string,
    provider_instance?: string
  ) {
    // Remove an item from the library.
    this.sendCommand("music/library/remove", {
      media_type,
      item_id,
      provider_domain,
      provider_instance,
    });
  }
  public async removeItemsFromLibrary(items: Array<MediaItemType | string>) {
    // Remove multiple items from the library (provide uri or MediaItem).
    this.sendCommand("music/library/remove_items", { items });
    // optimistically set the value
    for (const item of items) {
      if (typeof item !== "string") {
        item.in_library = false;
      }
    }
  }

  public async toggleLibrary(item: MediaItemType) {
    // Toggle in_library for a media item
    if (item.in_library) {
      await this.removeItemsFromLibrary([item]);
    } else {
      await this.addItemsToLibrary([item]);
    }
  }

  public async deleteDbItem(
    media_type: MediaType,
    db_item_id: string | number,
    recursive = false
  ) {
    // Remove item from the database.
    this.sendCommand("music/delete_db_item", {
      media_type,
      db_item_id,
      recursive,
    });
  }

  public browse(path?: string): Promise<BrowseFolder> {
    // Browse Music providers.
    return this.getData("music/browse", { path });
  }

  public search(
    search_query: string,
    media_types?: MediaType[],
    limit?: number
  ): Promise<MediaItemType[]> {
    // Perform global search for media items on all providers.
    return this.getData("music/search", { search_query, media_types, limit });
  }

  public async getPlayers(): Promise<Player[]> {
    // Get all registered players.
    return this.getData("players/all");
  }

  public async getPlayerQueues(): Promise<PlayerQueue[]> {
    // Get all registered PlayerQueues
    return this.getData("players/queue/all");
  }

  public async getPlayerQueueItems(queue_id: string): Promise<QueueItem[]> {
    // Get all QueueItems for given PlayerQueue
    return this.getData("players/queue/items", { queue_id });
  }

  public queueCommandPlay(queueId: string) {
    // Handle PLAY command for given queue.
    this.playerQueueCommand(queueId, "play");
  }
  public queueCommandPause(queueId: string) {
    // Handle PAUSE command for given queue.
    this.playerQueueCommand(queueId, "pause");
  }
  public queueCommandPlayPause(queueId: string) {
    // Toggle play/pause on given playerqueue.
    this.playerQueueCommand(queueId, "play_pause");
  }
  public queueCommandStop(queueId: string) {
    // Handle STOP command for given queue.
    this.playerQueueCommand(queueId, "stop");
  }
  public queueCommandNext(queueId: string) {
    // Handle NEXT TRACK command for given queue.
    this.playerQueueCommand(queueId, "next");
  }
  public queueCommandPrevious(queueId: string) {
    // Handle PREVIOUS TRACK command for given queue.
    this.playerQueueCommand(queueId, "previous");
  }
  public queueCommandClear(queueId: string) {
    // Clear all items in the queue.
    this.playerQueueCommand(queueId, "clear");
  }
  public queueCommandPlayIndex(queueId: string, index: number | string) {
    // Play item at index (or item_id) X in queue.
    this.playerQueueCommand(queueId, "play_index", { index });
  }
  public queueCommandMoveItem(
    queueId: string,
    queue_item_id: string,
    pos_shift: number = 1
  ) {
    // Move queue item x up/down the queue.
    // - queue_id: id of the queue to process this request.
    // - queue_item_id: the item_id of the queueitem that needs to be moved.
    // - pos_shift: move item x positions down if positive value
    // - pos_shift: move item x positions up if negative value
    // - pos_shift:  move item to top of queue as next item if 0
    this.playerQueueCommand(queueId, "move_item", { queue_item_id, pos_shift });
  }
  public queueCommandMoveUp(queueId: string, queue_item_id: string) {
    this.queueCommandMoveItem(queueId, queue_item_id, -1);
  }
  public queueCommandMoveDown(queueId: string, queue_item_id: string) {
    this.queueCommandMoveItem(queueId, queue_item_id, 1);
  }
  public queueCommandMoveNext(queueId: string, queue_item_id: string) {
    this.queueCommandMoveItem(queueId, queue_item_id, 0);
  }
  public queueCommandDelete(queueId: string, queue_item_id: string) {
    // Delete item (by id or index) from the queue.
    this.playerQueueCommand(queueId, "delete_item", { queue_item_id });
  }

  public queueCommandSeek(queueId: string, position: number) {
    // Handle SEEK command for given queue.
    // - position: position in seconds to seek to in the current playing item.
    this.playerQueueCommand(queueId, "seek", { position });
  }
  public queueCommandSkip(queueId: string, seconds: number) {
    // Handle SKIP command for given queue.
    // - seconds: number of seconds to skip in track. Use negative value to skip back.
    this.playerQueueCommand(queueId, "skip", { seconds });
  }
  public queueCommandSkipAhead(queueId: string) {
    this.queueCommandSkip(queueId, 10);
  }
  public queueCommandSkipBack(queueId: string) {
    this.queueCommandSkip(queueId, -10);
  }

  // player commands

  public playerCommandPower(playerId: string, powered: boolean) {
    this.playerCommand(playerId, "power", { powered });
  }

  public playerCommandPowerToggle(playerId: string) {
    this.playerCommandPower(playerId, !this.players[playerId].powered);
  }

  public playerCommandVolumeSet(playerId: string, newVolume: number) {
    this.playerCommand(playerId, "volume_set", {
      volume_level: newVolume,
    });
    this.players[playerId].volume_level = newVolume;
  }
  public playerCommandVolumeUp(playerId: string) {
    this.playerCommandVolumeSet(
      playerId,
      this.players[playerId].volume_level + 5
    );
  }
  public playerCommandVolumeDown(playerId: string) {
    this.playerCommandVolumeSet(
      playerId,
      this.players[playerId].volume_level - 5
    );
  }

  public queueCommandGroupVolume(queueId: string, newVolume: number) {
    this.playerCommand(queueId, "group_volume", {
      volume_level: newVolume,
    });
    this.players[queueId].group_volume = newVolume;
  }

  public playerQueueCommand(
    queue_id: string,
    command: string,
    args?: Record<string, any>
  ) {
    // apply a bit of throttling here (for the volume and seek sliders especially)
    clearTimeout(this._throttleId);
    this._throttleId = setTimeout(() => {
      this.sendCommand(`players/queue/${command}`, {
        queue_id,
        ...args,
      });
    }, 200);
  }

  public playerCommand(
    player_id: string,
    command: string,
    args?: Record<string, any>
  ) {
    // apply a bit of throttling here (for the volume and seek sliders especially)
    clearTimeout(this._throttleId);
    this._throttleId = setTimeout(() => {
      this.sendCommand(`players/cmd/${command}`, {
        player_id,
        ...args,
      });
    }, 200);
  }

  public playMedia(
    media: string | string[] | MediaItemType | MediaItemType[],
    option: QueueOption = QueueOption.PLAY,
    radio_mode?: boolean,
    queue_id?: string
  ) {
    if (!queue_id) {
      queue_id = store.selectedPlayer?.active_queue;
    }
    this.sendCommand("players/queue/play_media", {
      queue_id,
      media,
      option,
      radio_mode,
    });
  }

  public async playPlaylistFromIndex(
    playlist: Playlist,
    startIndex: number,
    queue_id?: string
  ) {
    const tracks = await this.getPlaylistTracks(
      playlist.provider,
      playlist.item_id
    );
    // to account for shuffle, we play the first track and append the rest
    this.playMedia(
      tracks[startIndex],
      QueueOption.REPLACE,
      undefined,
      queue_id
    );
    this.playMedia(
      tracks.slice(startIndex + 1),
      QueueOption.ADD,
      undefined,
      queue_id
    );
  }

  public async playAlbumFromItem(
    album: Album,
    startItem: Track,
    queue_id?: string
  ) {
    const tracks = await this.getAlbumTracks(album.provider, album.item_id);
    let startIndex = 0;
    tracks.forEach(function (track, i) {
      if (track.item_id == startItem.item_id) {
        startIndex = i;
      }
    });
    // to account for shuffle, we play the first track and append the rest
    this.playMedia(
      tracks[startIndex],
      QueueOption.REPLACE,
      undefined,
      queue_id
    );
    this.playMedia(
      tracks.slice(startIndex + 1),
      QueueOption.ADD,
      undefined,
      queue_id
    );
  }

  public startSync(media_types?: MediaType[], providers?: string[]) {
    // Start running the sync of (all or selected) musicproviders.
    // media_types: only sync these media types. omit for all.
    // providers: only sync these provider domains. omit for all.
    this.sendCommand("music/sync", { media_types, providers });
  }

  public getLocalThumb(path: string, size?: number): Promise<string> {
    // TODO
    return this.getData("thumb", { path, size });
  }

  private async connectHass() {
    // TODO
    // Connect to Music Assistant by using the Home Assistant API
    let auth;
    const authOptions = {
      async loadTokens() {
        try {
          return JSON.parse(localStorage.hassTokens);
        } catch (err) {
          return undefined;
        }
      },
      saveTokens: (tokens: any) => {
        localStorage.hassTokens = JSON.stringify(tokens);
      },
      hassUrl: "",
    };
    try {
      auth = await getAuth(authOptions);
    } catch (err) {
      if (err === ERR_HASS_HOST_REQUIRED) {
        authOptions.hassUrl =
          prompt(
            "Please enter the URL to Home Assistant",
            "http://homeassistant.local:8123"
          ) || "";
        if (!authOptions.hassUrl) return;
        auth = await getAuth(authOptions);
      } else {
        alert(`Unknown error: ${err}`);
        return;
      }
    }
    const connection = await createConnection({ auth });
    connection.addEventListener("ready", () => window.history.back());
    return connection;
  }

  private handleEventMessage(msg: EventMessage) {
    // Handle incoming MA event message
    if (msg.event == EventType.QUEUE_ADDED) {
      const queue = msg.data as PlayerQueue;
      this.queues[queue.queue_id] = queue;
    } else if (msg.event == EventType.QUEUE_UPDATED) {
      const queue = msg.data as PlayerQueue;
      if (queue.queue_id in this.queues)
        Object.assign(this.queues[queue.queue_id], queue);
      else this.queues[queue.queue_id] = queue;
    } else if (msg.event == EventType.QUEUE_TIME_UPDATED) {
      const queueId = msg.object_id as string;
      if (queueId in this.queues)
        this.queues[queueId].elapsed_time = msg.data as unknown as number;
    } else if (msg.event == EventType.PLAYER_ADDED) {
      const player = msg.data as Player;
      this.players[player.player_id] = player;
    } else if (msg.event == EventType.PLAYER_UPDATED) {
      const player = msg.data as Player;
      if (player.player_id in this.players)
        Object.assign(this.players[player.player_id], player);
      else this.players[player.player_id] = player;
    }
    // signal + log all events
    if (msg.event !== EventType.QUEUE_TIME_UPDATED) {
      // eslint-disable-next-line no-console
      console.log("[event]", msg);
    }
    this.signalEvent(msg);
  }

  private handleResultMessage(msg: SuccessResultMessage | ErrorResultMessage) {
    // Handle result of a command
    const resultPromise = this.commands.get(msg.message_id as number);
    if (!resultPromise) return;
    if ("error_code" in msg) {
      msg = msg as ErrorResultMessage;
      resultPromise.reject(msg.details || msg.error_code);
    } else {
      msg = msg as SuccessResultMessage;
      resultPromise.resolve(msg.result);
    }
    this.commands.delete(msg.message_id as number);
  }

  private handleServerInfoMessage(msg: ServerInfoMessage) {
    // Handle ServerInfo message which is sent as first message on connect
    this.state.value = ConnectionState.CONNECTED;
    this.serverInfo.value = msg;
    // trigger fetch of full state
    this._fetchState();
  }

  private signalEvent(evt: MassEvent) {
    // signal event to all listeners
    for (const listener of this.eventCallbacks) {
      if (listener[0] === EventType.ALL || listener[0] === evt.event) {
        listener[1](evt);
      }
    }
  }

  private getData<Result>(
    command: string,
    args?: Record<string, any>
  ): Promise<Result> {
    // send command to the server and return promise where the result can be returned
    const cmdId = this._genCmdId();
    return new Promise((resolve, reject) => {
      this.commands.set(cmdId, { resolve, reject });
      this.sendCommand(command, args, cmdId);
    });
  }

  private sendCommand(
    command: string,
    args?: Record<string, any>,
    msgId?: number
  ): void {
    if (this.state.value !== ConnectionState.CONNECTED) {
      throw "Connection lost";
    }

    if (!msgId) {
      msgId = this._genCmdId();
    }

    const msg: CommandMessage = {
      command: command,
      message_id: msgId,
      args,
    };

    if (DEBUG) {
      console.log("[sendCommand]", msg);
    }

    this.ws!.send(JSON.stringify(msg));
  }

  private async _fetchState() {
    // fetch full initial state
    for (const player of await this.getPlayers()) {
      this.players[player.player_id] = player;
    }
    for (const queue of await this.getPlayerQueues()) {
      this.queues[queue.queue_id] = queue;
    }

    const providers = await this.getData<ProviderInstance>("providers");
    Object.assign(this.providers, providers);
  }

  private _genCmdId() {
    return ++this.commandId;
  }
}

export const api = new MusicAssistantApi();
export default api;
