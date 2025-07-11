import { assertExists } from '@truckermudgeon/base/assert';
import { distance } from '@truckermudgeon/base/geom';
import { putIfAbsent } from '@truckermudgeon/base/map';
import { UnreachableError } from '@truckermudgeon/base/precon';
import {
  ItemType,
  MapOverlayType,
  SpawnPointType,
} from '@truckermudgeon/map/constants';
import { toMapPosition } from '@truckermudgeon/map/prefabs';
import type {
  Building,
  City,
  CityArea,
  CompanyItem,
  Curve,
  Cutscene,
  DefData,
  Ferry,
  FerryConnection,
  FerryItem,
  Item,
  MapArea,
  MapData,
  MapOverlay,
  Model,
  Node,
  Poi,
  Prefab,
  Road,
  Terrain,
  TrajectoryItem,
  Trigger,
} from '@truckermudgeon/map/types';
import * as cliProgress from 'cli-progress';
import path from 'path';
import { logger } from '../logger';
import { CombinedEntries } from './combined-entries';
import { convertSiiToJson } from './convert-sii-to-json';
import { parseDds } from './dds-parser';
import { parseDefFiles } from './def-parser';
import type { Entries } from './scs-archive';
import { ScsArchive, ScsArchiveFileV2 } from './scs-archive';
import { parseSector } from './sector-parser';
import {
  IconMatSchema,
  LocalizationSiiSchema,
  VersionSiiSchema,
} from './sii-schemas';

export function parseMapFiles(
  gameFilePaths: string[],
  modFilePaths: string[],
  {
    onlyDefs,
  }: {
    onlyDefs: boolean;
  },
):
  | {
      onlyDefs: false;
      map: string;
      mapData: MapData;
      icons: Map<string, Buffer>;
    }
  | {
      onlyDefs: true;
      map: string;
      defData: DefData;
    } {
  let version: ReturnType<typeof parseVersionSii>;
  let l10n = new Map<string, string>();
  let icons: ReturnType<typeof parseIconMatFiles> = new Map<string, Buffer>();
  let sectorData: ReturnType<typeof parseSectorFiles> = {
    map: '',
    sectors: new Map<
      string,
      { items: Map<bigint, Item>; nodes: Map<bigint, Node> }
    >(),
  };
  let defData: ReturnType<typeof parseDefFiles>;

  const gameArchives = gameFilePaths.map(p => {
    logger.log('adding', path.basename(p));
    return ScsArchive(p);
  });
  const modArchives = modFilePaths.map(p => {
    logger.log('adding', path.basename(p));
    return ScsArchive(p);
  });

  try {
    const gameEntries = new CombinedEntries(gameArchives);
    const entries = new CombinedEntries(gameArchives.concat(modArchives));

    version = parseVersionSii(gameEntries);
    l10n = parseLocaleFiles(gameEntries).get('en_us') ?? l10n;

    defData = parseDefFiles(entries, version.application);

    // parse game files
    if (!onlyDefs) {
      // TODO: find a solution to handle icons with same name between different mods
      icons = parseIconMatFiles(gameEntries);

      sectorData = parseSectorFiles(gameEntries, version.application);
    }
  } finally {
    gameArchives.forEach(a => a.dispose());
  }

  // parse mod files
  let success = 0;
  let failure = 0;
  for (const modArchive of modArchives) {
    logger.log('parsing', path.basename(modArchive.path));

    try {
      const modEntry = modArchive.parseEntries();

      const modL10n =
        parseLocaleFiles(modEntry).get('en_us') ?? new Map<string, string>();
      modL10n.forEach((v, k) => l10n.set(k, v));

      if (!onlyDefs) {
        const modIcons = parseIconMatFiles(modEntry);
        // TODO: find a solution to handle icons with same name between different mods
        modIcons.forEach((v, k) => icons.set(k, v));

        const modSectorData = parseSectorFiles(modEntry, version.application);
        modSectorData.sectors.forEach((v, k) => sectorData.sectors.set(k, v));

        if (modSectorData.error) {
          failure++;
        } else {
          success++;
        }
      }
    } catch (e) {
      logger.error(e);
      failure++;
    } finally {
      modArchive.dispose();
    }
  }

  if (modFilePaths.length > 0)
    logger.success(
      'success parsed',
      `${success} / ${modFilePaths.length}`,
      'mod files,',
      `${failure} failed`,
    );

  if (onlyDefs) {
    return {
      onlyDefs: true,
      map: version.application === 'ats' ? 'usa' : 'europe',
      defData: toDefData(defData, l10n),
    };
  }
  sectorData.map = version.application === 'ats' ? 'usa' : 'europe';
  return {
    onlyDefs: false,
    ...postProcess(defData, sectorData, icons, l10n),
  };
}

function parseVersionSii(entries: Entries) {
  const { application, version } = assertExists(
    Object.values(
      convertSiiToJson('version.sii', entries, VersionSiiSchema).fsPackSet,
    )[0],
  );
  logger.info('parsing', application, version);
  return { application, version };
}

export function parseSectorFiles(
  entries: Entries,
  application: 'ats' | 'eut2',
) {
  const sectors = new Map<
    string,
    { items: Map<bigint, Item>; nodes: Map<bigint, Node> }
  >();
  const mapDir = entries.directories.get('map');
  let maps;
  // some hashfs files don't have root path, try to search "map/europe" / "map/usa"
  if (mapDir) {
    maps = mapDir.subdirectories;
  } else if (application === 'eut2') {
    maps = ['europe'];
  } else if (application === 'ats') {
    maps = ['usa'];
  } else {
    return { map: '', sectors };
  }

  let error = false;
  for (const map of maps) {
    const sectorRoot = entries.directories.get(`map/${map}`);
    if (!sectorRoot) {
      continue;
    }

    const baseFiles = sectorRoot.files.filter(
      f => f.endsWith('.base') || f.endsWith('.aux'),
    );
    if (baseFiles.length === 0) continue;

    logger.start(`parsing ${map} sector files...`);
    const start = Date.now();
    const bar = new cliProgress.SingleBar(
      {
        format: `[{bar}] {percentage}% | {filename} | {value} of {total}`,
        stopOnComplete: true,
        clearOnComplete: true,
      },
      cliProgress.Presets.rect,
    );
    bar.start(baseFiles.length, 0);

    const sectorRegex = /^sec([+-]\d{4})([+-]\d{4})$/;
    for (const f of baseFiles) {
      const sectorKey = f.replace(/\.(base|aux)$/, '');
      if (!sectorRegex.test(sectorKey)) {
        logger.error(`unexpected sector key "${sectorKey}"`);
        error = true;
        bar.increment({ filename: f });
        continue;
      }
      const [, sectorX, sectorY] = Array.from(
        assertExists(sectorRegex.exec(sectorKey)),
        parseFloat,
      );
      if (isNaN(sectorX) || isNaN(sectorY)) {
        logger.error(`couldn't parse ${sectorX} or ${sectorY}`);
        error = true;
        bar.increment({ filename: f });
        continue;
      }

      const baseFile = entries.files.get(`map/${map}/${f}`);
      if (!baseFile) {
        bar.increment({ filename: f });
        continue;
      }

      const { items, nodes } = putIfAbsent(
        sectorKey,
        { items: new Map<bigint, Item>(), nodes: new Map<bigint, Node>() },
        sectors,
      );
      try {
        const buffer = baseFile.read();
        const sector = parseSector(buffer);
        if (!sector) {
          bar.increment({ filename: f });
          continue;
        }

        sector.items.forEach(item => {
          items.set(item.uid, { ...item, sectorX, sectorY });
        });
        sector.nodes.forEach(item => {
          nodes.set(item.uid, { ...item, sectorX, sectorY });
        });
      } catch {
        bar.increment({ filename: f });
        error = true;
        logger.error(`error parsing sector file`, `map/${map}/${f}`);
        continue;
      }
      bar.increment({ filename: f });
    }
    logger.success(
      'parsed',
      baseFiles.length,
      map,
      'sector files in',
      (Date.now() - start) / 1000,
      'seconds',
    );
  }

  return {
    map: `${maps.join('+')}`,
    sectors,
    error: error,
  };
}

export function parseLocaleFiles(
  entries: Entries,
): Map<string, Map<string, string>> {
  const l10nStrings = new Map<string, Map<string, string>>();

  let numKeys = 0;
  const locale = entries.directories.get('locale');
  if (!locale) return l10nStrings;

  if (locale.subdirectories.includes('en_us')) {
    logger.log('parsing locale files...');
    const localeSubdir = entries.directories.get(`locale/en_us`);
    if (!localeSubdir) return l10nStrings;

    const localeMap = putIfAbsent(
      'en_us',
      new Map<string, string>(),
      l10nStrings,
    );
    for (const f of localeSubdir.files) {
      if (!f.startsWith('local') && f !== 'photoalbum.sui') {
        continue;
      }
      const json = convertSiiToJson(
        `locale/en_us/${f}`,
        entries,
        LocalizationSiiSchema,
      );
      if (!json) continue;

      const l10n = json.localizationDb['.localization'];
      if (Object.keys(l10n).length === 0) {
        continue;
      }
      const { key, val } = l10n;

      for (let i = 0; i < key.length; i++) {
        localeMap.set(key[i], val[i]);
      }
    }
    // assumes all locales have the same number of entries.
    numKeys = localeMap.size;
  }

  logger.info(l10nStrings.size, 'locales,', numKeys, 'strings each');
  return l10nStrings;
}

export function parseIconMatFiles(entries: Entries) {
  logger.log('parsing icon .mat files...');

  const endsWithMat = /\.mat$/g;
  const tobjPaths = new Map<string, string>();
  const sdfAuxData = new Map<string, number[][]>();
  const readTobjPathsFromMatFiles = (
    dir: string,
    filenameFilter: (filename: string) => boolean = f => f.endsWith('.mat'),
    replaceAll: RegExp = endsWithMat,
  ) => {
    const dirEntry = entries.directories.get(dir);
    if (!dirEntry) return;

    for (const f of dirEntry.files) {
      if (!filenameFilter(f)) {
        continue;
      }

      const json = convertSiiToJson(`${dir}/${f}`, entries, IconMatSchema);
      if (Object.keys(json).length === 0) {
        continue;
      }
      const key = f.replaceAll(replaceAll, '');
      const fileEntry = entries.files.get(`${dir}/${f}`);
      if (json.effect) {
        const rfx = json.effect['ui.rfx'] ?? json.effect['ui.sdf.rfx'];
        if (!rfx) continue;

        if (fileEntry instanceof ScsArchiveFileV2) {
          tobjPaths.set(key, `${dir}/${rfx.texture.texture.source}`);
        } else {
          tobjPaths.set(
            key,
            `${dir}/${rfx.texture.texture.source.replace('.tobj', '.dds')}`,
          );
        }

        if (json.effect['ui.sdf.rfx']) {
          sdfAuxData.set(key, json.effect['ui.sdf.rfx'].aux);
        }
      } else if (json.material) {
        if (fileEntry instanceof ScsArchiveFileV2) {
          tobjPaths.set(key, `${dir}/${json.material.ui.texture}`);
        } else {
          tobjPaths.set(
            key,
            `${dir}/${json.material.ui.texture.replace('.tobj', '.dds')}`,
          );
        }
      } else {
        logger.warn(`unknown format for ${dir}/${f}`);
      }
    }
  };

  readTobjPathsFromMatFiles(
    'material/ui/map/road',
    f => f.startsWith('road_') && f.endsWith('.mat'),
    /^road_|\.mat$/g,
  );
  readTobjPathsFromMatFiles('material/ui/company/small');

  // hardcoded set of icon names that live in material/ui/map/
  const otherMatFiles = new Set(
    [
      'viewpoint', // for cutscenes (from ItemType.Cutscene)
      'photo_sight_captured', // for landmarks (from ItemType.MapOverlay, type Landmark)
      // facilities
      'parking_ico', // from ItemType.MapOverlay, type Parking; ItemType.Trigger; PrefabDescription TriggerPoints
      // from PrefabDescription SpawnPoints
      'gas_ico',
      'service_ico',
      'weigh_station_ico',
      'dealer_ico',
      'garage_large_ico',
      'recruitment_ico',
      // not rendered on map, but useful for Map Legend UI
      'city_names_ico',
      'companies_ico',
      'road_numbers_ico',
      // these 4 files can be combined to help trace state / country borders
      // 'map0',
      // 'map1',
      // 'map2',
      // 'map3',
    ].map(n => `${n}.mat`),
  );
  readTobjPathsFromMatFiles('material/ui/map', f => otherMatFiles.has(f));

  const pngs = new Map<string, Buffer>();
  for (const [key, tobjPath] of tobjPaths) {
    const tobj = entries.files.get(tobjPath);
    if (!tobj) {
      logger.warn('could not find', tobjPath);
      continue;
    }
    // A .tobj file in a HashFs v2 archive is actually a file with header-less
    // .dds pixel data. Assume that the concrete instance of the FileEntry for
    // the .tobj file is an ScsArchiveTobjFile, whose .read() returns a complete
    // header-ful .dds file.
    const DdsBuffer = parseDds(tobj.read(), sdfAuxData.get(key));
    if (DdsBuffer) {
      pngs.set(key, DdsBuffer);
    } else {
      logger.error(`error parsing ${tobjPath}`);
    }
  }
  if (pngs.size > 0) logger.info('parsed', pngs.size, 'icons');
  return pngs;
}

export function postProcess(
  defData: ReturnType<typeof parseDefFiles>,
  { sectors, map }: ReturnType<typeof parseSectorFiles>,
  icons: ReturnType<typeof parseIconMatFiles>,
  l10n: Map<string, string>,
): { map: string; mapData: MapData; icons: Map<string, Buffer> } {
  logger.log('building node and item LUTs...');
  const nodesByUid = new Map<bigint, Node>();
  const itemsByUid = new Map<bigint, Item>();
  for (const s of sectors.values()) {
    s.nodes.forEach((v, k) => nodesByUid.set(k, v));
    s.items.forEach((v, k) => itemsByUid.set(k, v));
  }
  logger.success('built', nodesByUid.size, 'node LUT entries');
  logger.success('built', itemsByUid.size, 'item LUT entries');

  const referencedNodeUids = new Set<bigint>();
  const elevationNodeUids = new Set<bigint>();
  const cityAreas = new Map<string, CityArea[]>();
  const prefabs: Prefab[] = [];
  const models: Model[] = [];
  const prefabsByUid = new Map<bigint, Prefab>();
  const mapAreas: MapArea[] = [];
  const cutscenes: Cutscene[] = [];
  const triggers: Trigger[] = [];
  const ferryItems = new Map<string, FerryItem>();
  const poifulItems: (
    | Prefab
    | MapOverlay
    | CompanyItem
    | FerryItem
    | Cutscene
    | Trigger
  )[] = [];
  const trajectories: TrajectoryItem[] = [];

  logger.log("checking items' references...");
  const start = Date.now();
  for (const item of itemsByUid.values()) {
    switch (item.type) {
      case ItemType.City:
        putIfAbsent(item.token, [], cityAreas).push(item);
        break;
      case ItemType.Road:
        checkReference(
          item.roadLookToken,
          defData.roadLooks,
          'roadLookToken',
          item,
        );
        checkReference(item.startNodeUid, nodesByUid, 'startNodeUid', item);
        checkReference(item.endNodeUid, nodesByUid, 'endNodeUid', item);
        referencedNodeUids.add(item.startNodeUid);
        referencedNodeUids.add(item.endNodeUid);
        elevationNodeUids.add(item.startNodeUid);
        elevationNodeUids.add(item.endNodeUid);
        break;
      case ItemType.Prefab:
        checkReference(item.token, defData.prefabs, 'prefab token', item);
        checkReference(item.nodeUids, nodesByUid, 'nodeUids', item);
        item.nodeUids.forEach(uid => {
          referencedNodeUids.add(uid);
          elevationNodeUids.add(uid);
        });
        prefabs.push(item);
        prefabsByUid.set(item.uid, item);
        poifulItems.push(item);
        break;
      case ItemType.MapArea:
        checkReference(item.nodeUids, nodesByUid, 'nodeUids', item);
        item.nodeUids.forEach(uid => {
          referencedNodeUids.add(uid);
          elevationNodeUids.add(uid);
        });
        mapAreas.push(item);
        break;
      case ItemType.MapOverlay:
        checkReference(item.nodeUid, nodesByUid, 'nodeUid', item);
        referencedNodeUids.add(item.nodeUid);
        poifulItems.push(item);
        break;
      case ItemType.Ferry:
        checkReference(item.nodeUid, nodesByUid, 'nodeUid', item);
        checkReference(item.token, defData.ferries, 'ferry token', item);
        if (defData.ferries.has(item.token)) {
          referencedNodeUids.add(item.nodeUid);
          ferryItems.set(item.token, item);
          poifulItems.push(item);
        }
        break;
      case ItemType.Company:
        checkReference(item.nodeUid, nodesByUid, 'nodeUid', item);
        checkReference(item.token, icons, 'company token', item);
        // disable this line when not processing every state; gets noisy otherwise.
        checkReference(item.cityToken, defData.cities, 'city token', item);
        referencedNodeUids.add(item.nodeUid);
        poifulItems.push(item);
        break;
      case ItemType.Cutscene:
        checkReference(item.nodeUid, nodesByUid, 'nodeUid', item);
        referencedNodeUids.add(item.nodeUid);
        poifulItems.push(item);
        cutscenes.push(item);
        break;
      case ItemType.Trigger:
        checkReference(item.nodeUids, nodesByUid, 'nodeUids', item);
        item.nodeUids.forEach(uid => referencedNodeUids.add(uid));
        poifulItems.push(item);
        triggers.push(item);
        break;
      case ItemType.Model:
        // sector parsing returns _all_ models, but
        // def parsing only cares about the ones it thinks are buildings.
        if (!defData.models.has(item.token)) {
          if (defData.vegetation.has(item.token)) {
            elevationNodeUids.add(item.nodeUid);
          }
          break;
        }
        checkReference(item.nodeUid, nodesByUid, 'startNodeUid', item);
        referencedNodeUids.add(item.nodeUid);
        models.push(item);
        break;
      case ItemType.Terrain:
      case ItemType.Building:
      case ItemType.Curve:
        // N.B.: Terrains, Buildings, and Curves are only used for their
        // elevations and aren't returned in their parsed forms.
        elevationNodeUids.add(item.startNodeUid);
        elevationNodeUids.add(item.endNodeUid);
        break;
      case ItemType.TrajectoryItem:
        checkReference(item.nodeUids, nodesByUid, 'nodeUids', item);
        item.nodeUids.forEach(uid => referencedNodeUids.add(uid));
        trajectories.push(item);
        break;
      default:
        throw new UnreachableError(item);
    }
  }
  logger.success(
    'checked',
    itemsByUid.size,
    'items in',
    (Date.now() - start) / 1000,
    'seconds',
  );

  logger.log('scanning', poifulItems.length, 'items for points of interest...');
  const pois: Poi[] = [];
  const companies: CompanyItem[] = [];
  const noPoiCompanies: {
    token: string;
    itemUid: bigint;
    nodeUid: bigint;
  }[] = [];
  const fallbackPoiCompanies: {
    token: string;
    itemUid: bigint;
    nodeUid: bigint;
  }[] = [];

  for (const item of poifulItems) {
    switch (item.type) {
      case ItemType.Prefab: {
        const prefabDescription = defData.prefabs.get(item.token);
        if (!prefabDescription) break;

        const prefabMeta = {
          prefabUid: item.uid,
          prefabPath: prefabDescription.path,
          sectorX: item.sectorX,
          sectorY: item.sectorY,
        };
        for (const sp of prefabDescription.spawnPoints) {
          const [x, y] = toMapPosition(
            [sp.x, sp.y],
            item,
            prefabDescription,
            nodesByUid,
          );
          const pos = {
            x,
            y,
          };
          switch (sp.type) {
            case SpawnPointType.GasPos:
              pois.push({
                ...prefabMeta,
                ...pos,
                type: 'facility',
                icon: 'gas_ico',
              });
              break;
            case SpawnPointType.ServicePos:
              pois.push({
                ...prefabMeta,
                ...pos,
                type: 'facility',
                icon: 'service_ico',
              });
              break;
            case SpawnPointType.WeightStationPos:
              pois.push({
                ...prefabMeta,
                ...pos,
                type: 'facility',
                icon: 'weigh_station_ico',
              });
              break;
            case SpawnPointType.TruckDealerPos:
              pois.push({
                ...prefabMeta,
                ...pos,
                type: 'facility',
                icon: 'dealer_ico',
              });
              break;
            case SpawnPointType.BuyPos:
              pois.push({
                ...prefabMeta,
                ...pos,
                type: 'facility',
                icon: 'garage_large_ico',
              });
              break;
            case SpawnPointType.RecruitmentPos:
              pois.push({
                ...prefabMeta,
                ...pos,
                type: 'facility',
                icon: 'recruitment_ico',
              });
              break;
            default:
              // TODO exhaustive switch, warn on unknown type.
              break;
          }
        }
        for (const tp of prefabDescription.triggerPoints) {
          const [x, y] = toMapPosition(
            [tp.x, tp.y],
            item,
            prefabDescription,
            nodesByUid,
          );
          if (tp.action === 'hud_parking') {
            pois.push({
              ...prefabMeta,
              type: 'facility',
              dlcGuard: item.dlcGuard,
              itemNodeUids: item.nodeUids,
              fromItemType: 'prefab',
              x,
              y,
              icon: 'parking_ico',
            });
          }
        }
        break;
      }
      case ItemType.MapOverlay: {
        const { x, y, sectorX, sectorY } = item;
        const pos = { x, y, sectorX, sectorY };
        switch (item.overlayType) {
          case MapOverlayType.Road:
            if (item.token === '') {
              // ignore
            } else if (!icons.has(item.token)) {
              logger.warn(
                `unknown road overlay token "${item.token}". skipping.`,
              );
            } else {
              // TODO look into ets2 road overlays with token 'weigh_ico'.
              // can they be considered facilities? do they have linked prefabs?
              pois.push({
                ...pos,
                type: 'road',
                dlcGuard: item.dlcGuard,
                nodeUid: item.nodeUid,
                icon: item.token,
              });
            }
            break;
          case MapOverlayType.Parking:
            pois.push({
              ...pos,
              type: 'facility',
              dlcGuard: item.dlcGuard,
              itemNodeUids: [item.nodeUid],
              icon: 'parking_ico',
              fromItemType: 'mapOverlay',
            });
            break;
          case MapOverlayType.Landmark: {
            const label =
              // Note: tried to treat this similar to viewpoints by searching
              // for entries in def files and matching item.uids, but item.uids
              // didn't match what was in the def files. Guessing landmark
              // object uids correspond to model uids, and not map overlay uids.
              l10n.get(`landmark_${item.token}`);
            if (label == null) {
              logger.warn(
                'missing landmark info for item',
                item.uid.toString(16),
              );
            }
            pois.push({
              ...pos,
              type: 'landmark',
              dlcGuard: item.dlcGuard,
              nodeUid: item.nodeUid,
              icon: 'photo_sight_captured',
              label: label ?? '',
            });
            break;
          }
        }
        break;
      }
      case ItemType.Company: {
        const prefabItem = prefabsByUid.get(item.prefabUid);
        if (!prefabItem) {
          logger.warn(
            'unknown prefab uid',
            item.prefabUid,
            'for company',
            item.token,
            `0x${item.uid.toString(16)}`,
          );
          break;
        }
        if (!icons.has(item.token)) {
          noPoiCompanies.push({
            token: item.token,
            itemUid: item.uid,
            nodeUid: item.nodeUid,
          });
          break;
        }

        const prefabDescription = defData.prefabs.get(prefabItem.token);
        if (!prefabDescription) break;
        const companySpawnPos = prefabDescription.spawnPoints.find(
          p => p.type === SpawnPointType.CompanyPos,
        );
        let x: number;
        let y: number;
        let sectorX: number;
        let sectorY: number;
        if (companySpawnPos) {
          [x, y] = toMapPosition(
            [companySpawnPos.x, companySpawnPos.y],
            prefabItem,
            prefabDescription,
            nodesByUid,
          );
          ({ sectorX, sectorY } = item);
        } else {
          fallbackPoiCompanies.push({
            token: item.token,
            itemUid: item.uid,
            nodeUid: item.nodeUid,
          });
          const node = nodesByUid.get(item.nodeUid);
          if (!node) break;
          ({ x, y, sectorX, sectorY } = node);
        }
        const companyName = defData.companies.get(item.token)?.name;
        if (companyName == null) {
          logger.warn('unknown company name for token', item.token);
        }
        const pos = { x, y, sectorX, sectorY };
        pois.push({
          ...pos,
          type: 'company',
          icon: item.token,
          label: companyName ?? item.token,
        });
        companies.push({
          ...item,
          x,
          y,
        });
        break;
      }
      case ItemType.Ferry: {
        const node = nodesByUid.get(item.nodeUid);
        if (!node) break;
        const { x, y, sectorX, sectorY } = node;
        const pos = { x, y, sectorX, sectorY };
        const ferry = defData.ferries.get(item.token);
        if (!ferry) break;
        const label = ferry.nameLocalized
          ? (l10n.get(ferry.nameLocalized.replaceAll('@', '')) ?? ferry.name)
          : ferry.name;
        pois.push({
          ...pos,
          type: item.train ? 'train' : 'ferry',
          icon: item.train ? 'train_ico' : 'port_overlay',
          label,
        });
        break;
      }
      case ItemType.Cutscene: {
        // a less magical check might be to read actions.stringParams,
        // and check that items 0 and 1 are "create" and "viewpoint".
        if ((item.flags & 0x00_00_00_ff) !== 0) {
          break;
        }
        const labelToken = defData.viewpoints.get(item.uid);
        const label = l10n.get(labelToken ?? '');
        if (label == null) {
          logger.warn('missing viewpoint info for item', item.uid.toString(16));
        }
        const { x, y, sectorX, sectorY } = item;
        const pos = { x, y, sectorX, sectorY };
        pois.push({
          ...pos,
          type: 'viewpoint',
          icon: 'viewpoint',
          label: label ?? '',
        });
        break;
      }
      case ItemType.Trigger: {
        const { x, y, sectorX, sectorY } = item;
        const pos = { x, y, sectorX, sectorY };
        if (item.actions.find(([key]) => key === 'hud_parking')) {
          pois.push({
            ...pos,
            type: 'facility',
            dlcGuard: item.dlcGuard,
            itemNodeUids: item.nodeUids,
            icon: 'parking_ico',
            fromItemType: 'trigger',
          });
        }
        break;
      }
      default:
        logger.error('unknown item type', item);
    }
  }

  if (noPoiCompanies.length) {
    logger.warn(
      noPoiCompanies.length,
      'companies with unknown tokens skipped\n',
      noPoiCompanies.sort((a, b) => a.token.localeCompare(b.token)),
    );
  }
  if (fallbackPoiCompanies.length) {
    logger.warn(
      fallbackPoiCompanies.length,
      'companies with no company spawn points (used node position as fallback)\n',
      fallbackPoiCompanies.sort((a, b) => a.token.localeCompare(b.token)),
    );
  }

  // Augment partial city info from defs with position info from sectors
  const cities = new Map<string, City>();
  for (const [token, partialCity] of defData.cities) {
    const areas = cityAreas.get(token);
    if (areas == null) {
      logger.warn(token, 'has no matching CityArea items. ignoring.');
      continue;
    }
    const nonHidden = areas.find(a => !a.hidden);
    if (!nonHidden) {
      logger.warn(token, 'has no "location" CityArea item. ignoring.');
      continue;
    }
    cities.set(token, {
      ...partialCity,
      x: nonHidden.x,
      y: nonHidden.y,
      areas,
    });
  }

  const withLocalizedName = createWithLocalizedName(l10n);

  // Augment partial ferry info from defs with start/end position info
  const ferries: Ferry[] = [];
  for (const [token, partialFerry] of defData.ferries) {
    const ferry = ferryItems.get(token);
    if (!ferry) continue;

    const { nodeUid, train } = ferry;
    const node = nodesByUid.get(nodeUid);
    if (!node) continue;

    const { x, y } = { x: node.x, y: node.y };
    const connections: FerryConnection[] = partialFerry.connections
      .filter(c => ferryItems.has(c.token))
      .map(partialConnection => {
        const nodeUid =
          ferryItems.get(partialConnection.token)?.nodeUid ?? BigInt(0);
        const node = nodesByUid.get(nodeUid);
        const { x, y } = node ? node : { x: 0, y: 0 };
        const ferry1 = defData.ferries.get(partialConnection.token);
        const name = ferry1?.name ?? '';
        const nameLocalized = ferry1?.nameLocalized;
        return {
          ...partialConnection,
          name,
          nameLocalized,
          nodeUid,
          x,
          y,
        };
      });
    ferries.push(
      withLocalizedName({
        ...partialFerry,
        train,
        connections,
        nodeUid,
        x,
        y,
      }),
    );
  }

  // Flag roads as possibly having terrain splitting them.
  // For performance, do this per-sector.
  // TODO use quadtree to speed this up.
  const roads: Road[] = [];
  const threshold = 2;
  let splitCount = 0;
  logger.start(
    'scanning sectors for roads possibly split by terrains or buildings',
  );
  const bar = new cliProgress.SingleBar(
    {
      format: `[{bar}] {percentage}% | {key} | {value} of {total}`,
      stopOnComplete: true,
      clearOnComplete: true,
    },
    cliProgress.Presets.rect,
  );
  bar.start(sectors.size, 0);
  const dividers: (Building | Curve)[] = [];
  for (const [key, { items }] of sectors.entries()) {
    const sectorRoads: Road[] = [];
    const sectorDividers: (Terrain | Building | Curve)[] = [];
    for (const i of items.values()) {
      if (i.type === ItemType.Road) {
        sectorRoads.push(i);
      } else if (i.type === ItemType.Terrain) {
        sectorDividers.push(i);
      } else if (i.type === ItemType.Building) {
        // HACK hardcoded checks for schemes that are known to be used as "center kerbs"
        if (i.scheme === 'scheme20') {
          sectorDividers.push(i);
        }
      } else if (i.type === ItemType.Curve) {
        // HACK hardcoded checks for models that are known to be used as "center kerbs".
        // TODO parse def file, check model_desc has a path that starts with 'model/road_island/'
        if (i.model === '0i03a' || i.model === '0i03b') {
          sectorDividers.push(i);
        }
      }
    }

    dividers.push(...sectorDividers.filter(d => d.type !== ItemType.Terrain));
    for (const d of dividers) {
      referencedNodeUids.add(d.startNodeUid);
      referencedNodeUids.add(d.endNodeUid);
    }

    for (const r of sectorRoads) {
      const rStart = nodesByUid.get(r.startNodeUid);
      const rEnd = nodesByUid.get(r.endNodeUid);
      if (!rStart || !rEnd) continue;
      const splitsRoad = (t: Terrain | Building | Curve) => {
        const tStart = nodesByUid.get(t.startNodeUid);
        const tEnd = nodesByUid.get(t.endNodeUid);
        if (!tStart || !tEnd) return false;
        return (
          (distance(rStart, tStart) < threshold &&
            distance(rEnd, tEnd) < threshold) ||
          (distance(rStart, tEnd) < threshold &&
            distance(rEnd, tStart) < threshold)
        );
      };
      if (sectorDividers.some(splitsRoad)) {
        roads.push({
          ...r,
          maybeDivided: true,
        });
        splitCount++;
      } else {
        roads.push(r);
      }
    }
    bar.increment({ key });
  }
  logger.success(
    splitCount,
    'roads possibly split by terrains, buildings, or curves',
  );

  // Augment mileage targets from defs with position info from sectors.
  for (const [token, target] of defData.mileageTargets) {
    if ((target.x && target.y) || !target.nodeUid) {
      continue;
    }
    const { nodeUid, ...targetWithoutNodeUid } = target;
    const node = nodesByUid.get(nodeUid);
    if (node) {
      defData.mileageTargets.set(token, {
        ...targetWithoutNodeUid,
        x: Math.round(node.x * 100) / 100, // easting
        y: Math.round(node.y * 100) / 100, // southing
      });
      logger.trace('node', nodeUid, 'found for mileage target', token);
    } else {
      logger.debug('node', nodeUid, 'not found for mileage target', token);
    }
  }

  logger.info(elevationNodeUids.size, 'elevation nodes');
  const referencedNodes: Node[] = [];
  for (const uid of referencedNodeUids) {
    const node = nodesByUid.get(uid);
    if (!node) continue;
    referencedNodes.push(node);
  }
  const elevationNodes: Node[] = [];
  for (const uid of elevationNodeUids) {
    const node = nodesByUid.get(uid);
    if (!node) continue;
    elevationNodes.push(node);
  }

  return {
    map,
    mapData: {
      nodes: referencedNodes,
      elevation: elevationNodes.map(
        ({ x, y, z }) =>
          [x, y, z].map(i => Math.round(i)) as [number, number, number],
      ),
      roads,
      ferries,
      prefabs,
      companies,
      models,
      mapAreas,
      pois,
      dividers,
      triggers,
      trajectories,
      cutscenes,
      countries: valuesWithTokens(defData.countries).map(withLocalizedName),
      cities: valuesWithTokens(cities).map(withLocalizedName),
      companyDefs: valuesWithTokens(defData.companies),
      roadLooks: valuesWithTokens(defData.roadLooks),
      prefabDescriptions: valuesWithTokens(defData.prefabs),
      modelDescriptions: valuesWithTokens(defData.models),
      achievements: valuesWithTokens(defData.achievements),
      routes: valuesWithTokens(defData.routes),
      mileageTargets: valuesWithTokens(defData.mileageTargets),
    },
    icons,
  };
}

function toDefData(
  defData: ReturnType<typeof parseDefFiles>,
  l10n: Map<string, string>,
) {
  const withLocalizedName = createWithLocalizedName(l10n);
  return {
    countries: valuesWithTokens(defData.countries).map(withLocalizedName),
    companyDefs: valuesWithTokens(defData.companies),
    roadLooks: valuesWithTokens(defData.roadLooks),
    prefabDescriptions: valuesWithTokens(defData.prefabs),
    modelDescriptions: valuesWithTokens(defData.models),
    achievements: valuesWithTokens(defData.achievements),
    routes: valuesWithTokens(defData.routes),
    mileageTargets: valuesWithTokens(defData.mileageTargets),
  };
}

function createWithLocalizedName(l10n: Map<string, string>) {
  return <T extends { name: string; nameLocalized: string | undefined }>(
    o: T,
  ) => ({
    ...o,
    nameLocalized: undefined,
    name: o.nameLocalized
      ? (l10n.get(o.nameLocalized.replaceAll('@', '')) ?? o.name)
      : o.name,
  });
}

function valuesWithTokens<V>(map: Map<string, V>): (V & { token: string })[] {
  return [...map.entries()].map(([token, v]) => ({ token, ...v }));
}

function checkReference<T>(
  ref: T | readonly T[],
  store: { has(ref: T): boolean },
  fieldName: string,
  item: Item,
) {
  let refs: readonly T[];
  if (Array.isArray(ref)) {
    refs = ref;
  } else {
    // casting `as T` because
    // https://github.com/microsoft/TypeScript/issues/17002
    refs = [ref as T];
  }

  for (const ref of refs) {
    if (!store.has(ref)) {
      logger.warn(
        `unknown ${fieldName}`,
        ref,
        `for item`,
        `0x${item.uid.toString(16)}.`,
      );
    }
  }
}
