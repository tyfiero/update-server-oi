// Native
const urlHelpers = require('url');

// Packages
const { send } = require('micro')
const { valid, compare } = require('semver')
const { parse } = require('express-useragent')
const fetch = require('node-fetch')
const distanceInWordsToNow = require('date-fns/distance_in_words_to_now')

// Utilities
const checkAlias = require('./aliases')
const prepareView = require('./view')

module.exports = ({ cache, config }) => {
  const { loadCache } = cache
  const exports = {}
  const { token, url } = config
  const shouldProxyPrivateDownload =
    token && typeof token === 'string' && token.length > 0

  // Helpers
  const proxyPrivateDownload = (asset, req, res) => {
    const redirect = 'manual'
    const headers = { Accept: 'application/octet-stream' }
    const options = { headers, redirect }
    const { api_url: rawUrl } = asset
    const finalUrl = rawUrl.replace(
      'https://api.github.com/',
      `https://${token}@api.github.com/`
    )

    fetch(finalUrl, options).then(assetRes => {
      res.setHeader('Location', assetRes.headers.get('Location'))
      send(res, 302)
    })
  }

  exports.download = async (req, res) => {
    const userAgent = parse(req.headers['user-agent'])
    const params = urlHelpers.parse(req.url, true).query
    const isUpdate = params && params.update

    let platform


    if (userAgent.isMac && isUpdate) {
      platform = 'darwin'
    } else if (userAgent.isMac && !isUpdate) {
      platform = 'dmg'
    } else if (userAgent.isWindows) {
      platform = 'exe'
    }
    console.log('Debug: Parsed User-Agent:', userAgent);
    console.log('Debug: Parsed User-Agent.isMac:', userAgent.isMac);
    console.log('Debug: Determined Platform:', platform);
    // Get the latest version from the cache
    const { platforms } = await loadCache()
    
    console.log('Debug: Platforms from Cache:', platforms);
    
    if (!platform || !platforms || !platforms[platform]) {
      send(res, 404, 'No download available for your platform!')
      return
    }

    if (shouldProxyPrivateDownload) {
      proxyPrivateDownload(platforms[platform], req, res)
      return
    }

    res.writeHead(302, {
      Location: platforms[platform].url
    })

    res.end()
  }

  exports.downloadPlatform = async (req, res) => {

    
    const params = urlHelpers.parse(req.url, true).query;
    const isUpdate = params && params.update;
    console.log(`Debug: Received isUpdate = ${isUpdate}`);

    let { platform } = req.params;
    console.log(`Debug: Initial platform = ${platform}`);
    if (platform === 'mac' && !isUpdate) {
      platform = 'dmg';
    }

    if (platform === 'mac_arm64' && !isUpdate) {
      platform = 'dmg_arm64';
    }
    // if (isUpdate && platform === 'darwin') {
    //   platform = 'dmg';
    // }

    // Get the latest version from the cache
    const latest = await loadCache();
    console.log(`Debug: Loaded cache = ${JSON.stringify(latest)}`);

    // Check platform for appropriate aliases
    platform = checkAlias(platform);
    console.log(`Debug: Checked alias, new platform = ${platform}`);

    if (!platform) {
      console.log("Debug: Platform not valid");
      send(res, 500, 'The specified platform is not valid');
      return;
    }

    if (!latest.platforms || !latest.platforms[platform]) {
      console.log("Debug: No download available for platform");
      send(res, 404, 'No download available for your platform');
      return;
    }

    if (token && typeof token === 'string' && token.length > 0) {
      console.log("Debug: Proxying private download");
      proxyPrivateDownload(latest.platforms[platform], req, res);
      return;
    }

    console.log(`Debug: Redirecting to URL: ${latest.platforms[platform].url}`);
    res.writeHead(302, {
      Location: latest.platforms[platform].url
    });

    res.end();
};

 exports.update = async (req, res) => {
    console.log("Debug: Entering the 'update' function");
    const { platform: platformName, version } = req.params;

    console.log(`Debug: Received platformName = ${platformName}, version = ${version}`);

    if (!valid(version)) {
      console.log("Debug: Version is not SemVer-compatible");
      send(res, 500, {
        error: 'version_invalid',
        message: 'The specified version is not SemVer-compatible'
      });
      return;
    }

    const platform = checkAlias(platformName);
    console.log(`Debug: Mapped platformName = ${platformName} to platform = ${platform}`);

    if (!platform) {
      console.log("Debug: Platform is not valid");
      send(res, 500, {
        error: 'invalid_platform',
        message: 'The specified platform is not valid'
      });
      return;
    }

    // Get the latest version from the cache
    const latest = await loadCache();
    console.log("Debug: Loaded cache", latest);
    console.log(`Debug: Checking if platform ${platform} exists in cache`, latest.platforms);
    // const platformMap = {
    //   'darwin': 'dmg',
    //   'win32': 'exe'
    // };
    // const cacheKey = platformMap[platform] || platform;
    if (!latest.platforms || !latest.platforms[platform]) {
      console.log("Debug: Platform not found in cache or cache empty");
      res.statusCode = 204;
      res.end();
      return;
    }

    console.log(`Debug: Comparing client version ${version} with latest version ${latest.version}`);
    if (compare(latest.version, version) !== 0) {
      console.log("Debug: Versions are different, preparing to send update");
      const { notes, pub_date } = latest;

      send(res, 200, {
        name: latest.version,
        notes,
        pub_date,
        url: shouldProxyPrivateDownload
          ? `https://${url}/download/${platformName}?update=true`
          : latest.platforms[platform].url
      });
      return;
    }

    console.log("Debug: Versions are the same, sending 204");
    res.statusCode = 204;
    res.end();
};

  exports.releases = async (req, res) => {
    // Get the latest version from the cache
    const latest = await loadCache()

    if (!latest.files || !latest.files.RELEASES) {
      res.statusCode = 204
      res.end()

      return
    }

    const content = latest.files.RELEASES

    res.writeHead(200, {
      'content-length': Buffer.byteLength(content, 'utf8'),
      'content-type': 'application/octet-stream'
    })

    res.end(content)
  }

  exports.overview = async (req, res) => {
    const latest = await loadCache()

    try {
      const render = await prepareView()

      const details = {
        account: config.account,
        repository: config.repository,
        date: distanceInWordsToNow(latest.pub_date, { addSuffix: true }),
        files: latest.platforms,
        version: latest.version,
        releaseNotes: `https://github.com/${config.account}/${
          config.repository
        }/releases/tag/${latest.version}`,
        allReleases: `https://github.com/${config.account}/${
          config.repository
        }/releases`,
        github: `https://github.com/${config.account}/${config.repository}`
      }

      send(res, 200, render(details))
    } catch (err) {
      console.error(err)
      send(res, 500, 'Error reading overview file')
    }
  }

  return exports
}
