const { version } = require('../repositoryUtils');

function createPrivateCollectionConfig(fabricVersion, channel, name, orgNames) {
  // We need only orgs that can have access to private data
  const relevantOrgs = (channel.orgs || []).filter((o) => !!orgNames.find((n) => n === o.name));
  if (relevantOrgs.length < orgNames.length) { throw new Error(`Cannot find all orgs for names ${orgNames}`); }

  const policy = `OR(${relevantOrgs.map((o) => `'${o.mspName}.member'`).join(',')})`;
  const peerCounts = relevantOrgs.map((o) => (o.peers || []).length);
  const totalPeers = peerCounts.reduce((a, b) => a + b, 0);

  // We need enough peers to exceed one org (max in org + 1) and up to totalPeers - 1
  const requiredPeerCount = Math.min(
    totalPeers - 1,
    peerCounts.reduce((a, b) => Math.max(a, b), 0) + 1,
  );

  const maxPeerCount = Math.max(
    requiredPeerCount,
    Math.min(requiredPeerCount * 2, totalPeers - 1),
  );

  const memberOnlyRead = version(fabricVersion).isGreaterOrEqual('1.4.0') ? { memberOnlyRead: true } : {};
  const memberOnlyWrite = version(fabricVersion).isGreaterOrEqual('2.0.0') ? { memberOnlyWrite: true } : {};

  return {
    name,
    policy,
    requiredPeerCount,
    maxPeerCount,
    blockToLive: 0,
    ...memberOnlyRead,
    ...memberOnlyWrite,
  };
}

function transformChaincodesConfig(fabricVersion, chaincodes, transformedChannels) {
  return chaincodes.map((chaincode) => {
    const channel = transformedChannels.find((c) => c.key === chaincode.channel);
    if (!channel) throw new Error(`No matching channel with key '${chaincode.channel}'`);

    const privateData = (chaincode.privateData || [])
      .map((d) => createPrivateCollectionConfig(fabricVersion, channel, d.name, d.orgNames));

    return {
      directory: chaincode.directory,
      name: chaincode.name,
      version: chaincode.version,
      lang: chaincode.lang,
      channel,
      init: chaincode.init,
      endorsement: chaincode.endorsement,
      instantiatingOrg: channel.instantiatingOrg,
      privateData,
    };
  });
}

function transformOrderersConfig(ordererJsonConfigFormat, rootDomainJsonConfigFormat) {
  const type = ordererJsonConfigFormat.type === 'raft' ? 'etcdraft' : ordererJsonConfigFormat.type;

  return Array(ordererJsonConfigFormat.instances)
    .fill()
    .map((x, i) => i)
    .map((i) => {
      const name = `${ordererJsonConfigFormat.prefix}${i}`;
      const address = `${name}.${rootDomainJsonConfigFormat}`;
      const port = 7050 + i;
      return {
        name,
        domain: rootDomainJsonConfigFormat,
        address,
        consensus: type,
        port,
        fullAddress: `${address}:${port}`,
      };
    });
}

function transformCaConfig(caJsonFormat, orgName, orgDomainJsonFormat, caExposePort) {
  const address = `${caJsonFormat.prefix}.${orgDomainJsonFormat}`;
  const port = 7054;
  return {
    prefix: caJsonFormat.prefix,
    address,
    port,
    exposePort: caExposePort,
    fullAddress: `${address}:${port}`,
    caAdminNameVar: `${orgName.toUpperCase()}_CA_ADMIN_NAME`,
    caAdminPassVar: `${orgName.toUpperCase()}_CA_ADMIN_PASSWORD`,
  };
}

function transformRootOrgConfig(rootOrgJsonFormat) {
  const { domain } = rootOrgJsonFormat.organization;
  const orderersExtended = transformOrderersConfig(
    rootOrgJsonFormat.orderer,
    domain,
  );
  const ordererHead = orderersExtended[0];
  return {
    name: rootOrgJsonFormat.organization.name,
    mspName: rootOrgJsonFormat.organization.mspName,
    domain,
    organization: rootOrgJsonFormat.organization,
    ca: transformCaConfig(rootOrgJsonFormat.ca, rootOrgJsonFormat.organization.name, domain, 7030),
    orderers: orderersExtended,
    ordererHead,
  };
}

function extendPeers(peerJsonFormat, domainJsonFormat, headPeerPort, headPeerCouchDbExposePort) {
  let { anchorPeerInstances } = peerJsonFormat;
  if (typeof anchorPeerInstances === 'undefined' || anchorPeerInstances === null) {
    anchorPeerInstances = 1;
  }
  return Array(peerJsonFormat.instances)
    .fill()
    .map((x, i) => i)
    .map((i) => {
      const address = `peer${i}.${domainJsonFormat}`;
      const port = headPeerPort + i;
      return {
        name: `peer${i}`,
        address,
        db: peerJsonFormat.db,
        isAnchorPeer: i < anchorPeerInstances,
        port,
        fullAddress: `${address}:${port}`,
        couchDbExposePort: headPeerCouchDbExposePort + i,
      };
    });
}

function transformOrgConfig(orgJsonFormat, orgNumber) {
  const orgsCryptoConfigFileName = `crypto-config-${orgJsonFormat.organization.name.toLowerCase()}`;
  const headPeerPort = 7060 + 10 * orgNumber;
  const headPeerCouchDbExposePort = 5080 + 10 * orgNumber;
  const caExposePort = 7031 + orgNumber;
  const orgName = orgJsonFormat.organization.name;
  const orgDomain = orgJsonFormat.organization.domain;

  const peersExtended = extendPeers(
    orgJsonFormat.peer,
    orgDomain,
    headPeerPort,
    headPeerCouchDbExposePort,
  );
  const anchorPeers = peersExtended.filter((p) => p.isAnchorPeer);
  const bootstrapPeersList = anchorPeers.map((a) => a.fullAddress);

  return {
    key: orgJsonFormat.organization.key,
    name: orgName,
    mspName: orgJsonFormat.organization.mspName,
    domain: orgDomain,
    cryptoConfigFileName: orgsCryptoConfigFileName,
    peersCount: peersExtended.length,
    peers: peersExtended,
    anchorPeers,
    bootstrapPeers: bootstrapPeersList.join(' '),
    ca: transformCaConfig(orgJsonFormat.ca, orgName, orgDomain, caExposePort),
    headPeer: peersExtended[0],
  };
}

function transformOrgConfigs(orgsJsonConfigFormat) {
  return orgsJsonConfigFormat.map((org, currentIndex) => transformOrgConfig(org, currentIndex));
}

function filterToAvailablePeers(orgTransformedFormat, peersTransformedFormat) {
  const filteredPeers = orgTransformedFormat.peers.filter(
    (p) => peersTransformedFormat.includes(p.name),
  );
  return {
    name: orgTransformedFormat.name,
    mspName: orgTransformedFormat.mspName,
    domain: orgTransformedFormat.domain,
    peers: filteredPeers,
    headPeer: filteredPeers[0],
  };
}

function transformChannelConfig(channelJsonFormat, orgsTransformed) {
  const orgKeys = channelJsonFormat.orgs.map((o) => o.key);
  const orgPeers = channelJsonFormat.orgs.map((o) => o.peers)
    .reduce((a, b) => a.concat(b), []);
  const orgsForChannel = orgsTransformed
    .filter((org) => orgKeys.includes(org.key))
    .map((org) => filterToAvailablePeers(org, orgPeers));

  return {
    key: channelJsonFormat.key,
    name: channelJsonFormat.name,
    orgs: orgsForChannel,
    instantiatingOrg: orgsForChannel[0],
  };
}

function transformChannelConfigs(channelsJsonConfigFormat, orgsTransformed) {
  return channelsJsonConfigFormat.map((ch) => transformChannelConfig(ch, orgsTransformed));
}

// Used https://github.com/hyperledger/fabric/blob/v1.4.8/sampleconfig/configtx.yaml for values
const networkCapabilities = {
  '2.2.1': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },
  '2.2.0': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },
  '2.1.1': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },
  '2.1.0': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },
  '2.0.1': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },

  '1.4.8': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },
  '1.4.7': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },
  '1.4.6': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },
  '1.4.5': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },
  '1.4.4': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },
  '1.4.3': { channel: 'V1_4_3', orderer: 'V1_4_2', application: 'V1_4_2' },
  '1.4.2': { channel: 'V1_4_2', orderer: 'V1_4_2', application: 'V1_4_2' },
  '1.4.1': { channel: 'V1_3', orderer: 'V1_1', application: 'V1_3' },
  '1.4.0': { channel: 'V1_3', orderer: 'V1_1', application: 'V1_3' },
  '1.3.0': { channel: 'V1_3', orderer: 'V1_1', application: 'V1_3' },
};

function getNetworkCapabilities(fabricVersion) {
  return networkCapabilities[fabricVersion] || networkCapabilities['1.4.8'];
}

function isHlf20(fabricVersion) {
  const supported20Versions = ['2.2.1', '2.2.0', '2.1.1', '2.1.0', '2.0.1'];
  return supported20Versions.includes(fabricVersion);
}

function getCaVersion(fabricVersion) {
  return (version(fabricVersion).isGreaterOrEqual('1.4.10') ? '1.5.0' : fabricVersion);
}

function getEnvVarOrThrow(name) {
  const value = process.env[name];
  if (!value || !value.length) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function getPathsFromEnv() {
  return {
    fabricaConfig: getEnvVarOrThrow('FABRICA_CONFIG'),
    chaincodesBaseDir: getEnvVarOrThrow('CHAINCODES_BASE_DIR'),
  };
}

function transformNetworkSettings(networkSettingsJson) {
  return {
    ...networkSettingsJson,
    fabricCaVersion: getCaVersion(networkSettingsJson.fabricVersion),
    paths: getPathsFromEnv(),
    isHlf20: isHlf20(networkSettingsJson.fabricVersion),
  };
}

module.exports = {
  transformChaincodesConfig,
  transformRootOrgConfig,
  transformOrgConfigs,
  transformChannelConfigs,
  getNetworkCapabilities,
  transformNetworkSettings,
};
