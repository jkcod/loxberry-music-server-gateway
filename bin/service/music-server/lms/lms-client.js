'use strict';

var net = require('net');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync("config.json"));

var notificationSocket
var cmdSocket

module.exports = class LMSClient {
    constructor(mac, data_callback) {
        this._mac = mac;
        if (!this._mac)
            this._mac = ""
        this.data_callback = data_callback;

        if (!notificationSocket) {
            notificationSocket = net.createConnection({ host: config.lms_host, port: config.lms_cli_port }, () => {
                                                          notificationSocket.write('listen 1 \r\n');
                                                      });
            notificationSocket.setMaxListeners(200);
        }

        if (this.data_callback) {

            notificationSocket.on('data', (data) => {
                                      var splitted = data.toString().split('\n')

                                      for (var i in splitted) {
                                          var dataStr = splitted[i];

                                          // check whether the notification is for us
                                          let encoded_mac = this._mac.replace(/:/g, "%3A");
                                          if (!dataStr.startsWith(encoded_mac))
                                              return

                                          // Remove the zone id from the notification
                                          dataStr = dataStr.slice(encoded_mac.length).trim();

                                          this.data_callback(dataStr);
                                      }
                                  });
        }

        if (!cmdSocket) {
            cmdSocket = net.createConnection({ host: config.lms_host, port: config.lms_cli_port }, () => {
                                                   console.debug('doTelnet connected to server!');
                                               });
            cmdSocket.setMaxListeners(200);
            cmdSocket.on('end', () => {
                               console.debug('doTelnet disconnected from server');
                           });
            cmdSocket.on('timeout', () => {
                               console.debug('doTelnet Socket timeout, closing');
                               cmdSocket.close();
                           });
            cmdSocket.on('error', (err) => {
                               console.debug('doTelnet Socket error: ' + err.message);
                           });
            cmdSocket.on('close', (err) => {
                               console.debug('doTelnet Socket closed');
                           });
        }

    }

    async command(cmd) {
        var returnValue = cmd;
        if (this._mac)
            returnValue = this._mac + " " + returnValue
        if (returnValue.endsWith("?"))
            returnValue = returnValue.slice(0, -2);

        returnValue = returnValue.replace(/:/g, "%3A")
        returnValue = returnValue.replace(/\//g, "%2F")

        return new Promise((resolve, reject) => {
                               var responseListener = (data) => {
                                   var splitted = data.toString().split('\n')
//                                   console.log("RESPONSE", splitted, returnValue)
                                   for (var i in splitted) {
                                       var processed = splitted[i];
                                       if (processed.startsWith(returnValue)) {
//                                           console.log("RESPONSE FOR: ", returnValue)
//                                           console.log("RESPONSE: ", data.toString())
                                           // Once we have the response we wait for return
                                           cmdSocket.removeListener('data', responseListener);
                                           processed = processed.replace(returnValue, "")
                                           processed = processed.replace("\r", '')
                                           processed = processed.replace("\n", '')
                                           processed = processed.trim()
                                           resolve(processed);
                                       }
                                   }
                               };

                               cmdSocket.on('data', responseListener);
//                               console.log("REQUEST: ", this._mac + " " + cmd)
                               cmdSocket.write(this._mac + " " + cmd + ' \r\n');
                           });
    }


    parseAdvancedQueryResponse(data, object_split_key, filteredKeys, count_key = 'count') {
        // Remove leading/trailing white spaces
        let count = 0
        let response = data.trim();
        let strings = response.split(' ')
        let current_item = {}
        let items = []
        for (let i in strings) {
            var str = strings[i];
            var colon = '%3A';
            var index = str.indexOf(colon)
            var key = str.slice(0, index);
            var value = str.slice(index + colon.length);
//            console.log("STR ", str, index, key, value)

            if (key == count_key) {
                count = parseInt(value);
                continue
            }

            if (Array.isArray(filteredKeys)) {
                if (filteredKeys.includes(key))
                    continue
            }

            if (object_split_key) {
                if (key == object_split_key) {
                    if (Object.keys(current_item).length !== 0)
                        items.push(current_item);
                    current_item = {};
                }
            }
            current_item[key] = value;
        }
        if (Object.keys(current_item).length !== 0)
            items.push(current_item);
//        console.log("ITEMS ", JSON.stringify(items))
        return {
            count: count,
            items: items
        };
    }

    parseAdvancedQueryResponse2(data, requiredKeys, count_key = 'count') {
        // Remove leading/trailing white spaces
        let count = 0
        let response = data.trim();
        let strings = response.split(' ')
        let current_item = {}
        let items = []
        for (let i in strings) {
            var str = strings[i];
            var colon = '%3A';
            var index = str.indexOf(colon)
            var key = str.slice(0, index);
            var value = str.slice(index + colon.length);

            if (key == count_key) {
                count = parseInt(value);
                continue
            }
            current_item[key] = value;

            const keys = Object.keys(current_item);
            if (requiredKeys.every(val => keys.includes(val))) {
                items.push(current_item);
                current_item = {};
            }
        }
        if (Object.keys(current_item).length !== 0)
            items.push(current_item);

        return {
            count: count,
            items: items
        };
    }

    async artworkFromTrackId(id) {
        if (!id)
            return undefined;
        let response = await this.command('songinfo 0 100 track_id:' + id)
        let item = this.parseAdvancedQueryResponse(response).items[0];

        return this.extractArtwork("", item);
    }

    async artworkFromUrl(url) {
        if (!url)
            return undefined;
        let response = await this.command('songinfo 0 100 url:' + url)
        let item = this.parseAdvancedQueryResponse(response).items[0];

        return this.extractArtwork(url, item);
    }

    extractArtwork(url, item) {
        if ('artwork_track_id' in item) {
            return "http://" + config.lms_host + ":" + config.lms_port + "/music/" + item['artwork_track_id'] + "/cover"
        }

        if ('image' in item) {
            return "http://" + config.lms_host + ":" + config.lms_port + item['image']
        }

        if ('icon' in item) {
            return "http://" + config.lms_host + ":" + config.lms_port + item['icon']
        }

        if ('artwork_url' in item) {
            let artwork_url = unescape(item['artwork_url']);
            if (artwork_url.startsWith("http"))
                return artwork_url;

            // Before accepting this default icon, try to be smart and parse the ID of the station
            // and resolve the icon ourself
            if (artwork_url == "plugins/TuneIn/html/images/icon.png") {
                var regex = /id%3Ds(\d+)%26/
                var match = regex.exec(url);
                if (match && match[1]) {
                    return "http://" + config.lms_host + ":" + config.lms_port + '/imageproxy/http%3A%2F%2Fcdn-radiotime-logos.tunein.com%2Fs' + match[1] + 'q.png/image.png'
                }
            }

            if (!artwork_url.startsWith("/"))
                artwork_url = "/" + artwork_url

            return "http://" + config.lms_host + ":" + config.lms_port + artwork_url;
        }

        return undefined
    }

    parseId(str) {
        if (!str.includes(":"))
            return {type: "", id: str }
        let s = str.toString().split(":")
        return {type:s[0], id:s[1]};
    }
}
