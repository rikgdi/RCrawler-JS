const { createCrawler, Crawler } = require('./crawler');
const convertChunks = require('./convert');

module.exports = createCrawler;
module.exports.createCrawler = createCrawler;
module.exports.Crawler = Crawler;
module.exports.convertChunks = convertChunks;
