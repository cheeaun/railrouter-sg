!function(){try{self["workbox:core:6.2.4"]&&_()}catch(e){}const e=(e,...t)=>{let s=e;return t.length>0&&(s+=` :: ${JSON.stringify(t)}`),s};class t extends Error{constructor(t,s){super(e(t,s)),this.name=t,this.details=s}}try{self["workbox:routing:6.2.4"]&&_()}catch(e){}const s=e=>e&&"object"==typeof e?e:{handle:e};class n{constructor(e,t,n="GET"){this.handler=s(t),this.match=e,this.method=n}setCatchHandler(e){this.catchHandler=s(e)}}class a extends n{constructor(e,t,s){super((({url:t})=>{const s=e.exec(t.href);if(s&&(t.origin===location.origin||0===s.index))return s.slice(1)}),t,s)}}const r=e=>new URL(String(e),location.href).href.replace(new RegExp(`^${location.origin}`),"");class i{constructor(){this._routes=new Map,this._defaultHandlerMap=new Map}get routes(){return this._routes}addFetchListener(){self.addEventListener("fetch",(e=>{const{request:t}=e,s=this.handleRequest({request:t,event:e});s&&e.respondWith(s)}))}addCacheListener(){self.addEventListener("message",(e=>{if(e.data&&"CACHE_URLS"===e.data.type){const{payload:t}=e.data,s=Promise.all(t.urlsToCache.map((t=>{"string"==typeof t&&(t=[t]);const s=new Request(...t);return this.handleRequest({request:s,event:e})})));e.waitUntil(s),e.ports&&e.ports[0]&&s.then((()=>e.ports[0].postMessage(!0)))}}))}handleRequest({request:e,event:t}){const s=new URL(e.url,location.href);if(!s.protocol.startsWith("http"))return;const n=s.origin===location.origin,{params:a,route:r}=this.findMatchingRoute({event:t,request:e,sameOrigin:n,url:s});let i=r&&r.handler;const o=e.method;if(!i&&this._defaultHandlerMap.has(o)&&(i=this._defaultHandlerMap.get(o)),!i)return;let c;try{c=i.handle({url:s,request:e,event:t,params:a})}catch(e){c=Promise.reject(e)}const h=r&&r.catchHandler;return c instanceof Promise&&(this._catchHandler||h)&&(c=c.catch((async n=>{if(h)try{return await h.handle({url:s,request:e,event:t,params:a})}catch(e){e instanceof Error&&(n=e)}if(this._catchHandler)return this._catchHandler.handle({url:s,request:e,event:t});throw n}))),c}findMatchingRoute({url:e,sameOrigin:t,request:s,event:n}){const a=this._routes.get(s.method)||[];for(const r of a){let a;const i=r.match({url:e,sameOrigin:t,request:s,event:n});if(i)return a=i,(Array.isArray(a)&&0===a.length||i.constructor===Object&&0===Object.keys(i).length||"boolean"==typeof i)&&(a=void 0),{route:r,params:a}}return{}}setDefaultHandler(e,t="GET"){this._defaultHandlerMap.set(t,s(e))}setCatchHandler(e){this._catchHandler=s(e)}registerRoute(e){this._routes.has(e.method)||this._routes.set(e.method,[]),this._routes.get(e.method).push(e)}unregisterRoute(e){if(!this._routes.has(e.method))throw new t("unregister-route-but-not-found-with-method",{method:e.method});const s=this._routes.get(e.method).indexOf(e);if(!(s>-1))throw new t("unregister-route-route-not-registered");this._routes.get(e.method).splice(s,1)}}let o;const c=()=>(o||(o=new i,o.addFetchListener(),o.addCacheListener()),o);function h(e,s,r){let i;if("string"==typeof e){const t=new URL(e,location.href);i=new n((({url:e})=>e.href===t.href),s,r)}else if(e instanceof RegExp)i=new a(e,s,r);else if("function"==typeof e)i=new n(e,s,r);else{if(!(e instanceof n))throw new t("unsupported-route-type",{moduleName:"workbox-routing",funcName:"registerRoute",paramName:"capture"});i=e}return c().registerRoute(i),i}const u={googleAnalytics:"googleAnalytics",precache:"precache-v2",prefix:"workbox",runtime:"runtime",suffix:"undefined"!=typeof registration?registration.scope:""},l=e=>[u.prefix,e,u.suffix].filter((e=>e&&e.length>0)).join("-"),d=e=>e||l(u.googleAnalytics),m=e=>e||l(u.runtime);function p(e,t){const s=new URL(e);for(const e of t)s.searchParams.delete(e);return s.href}class w{constructor(){this.promise=new Promise(((e,t)=>{this.resolve=e,this.reject=t}))}}const f=new Set;function g(e){return new Promise((t=>setTimeout(t,e)))}try{self["workbox:strategies:6.2.4"]&&_()}catch(e){}function y(e){return"string"==typeof e?new Request(e):e}class b{constructor(e,t){this._cacheKeys={},Object.assign(this,t),this.event=t.event,this._strategy=e,this._handlerDeferred=new w,this._extendLifetimePromises=[],this._plugins=[...e.plugins],this._pluginStateMap=new Map;for(const e of this._plugins)this._pluginStateMap.set(e,{});this.event.waitUntil(this._handlerDeferred.promise)}async fetch(e){const{event:s}=this;let n=y(e);if("navigate"===n.mode&&s instanceof FetchEvent&&s.preloadResponse){const e=await s.preloadResponse;if(e)return e}const a=this.hasCallback("fetchDidFail")?n.clone():null;try{for(const e of this.iterateCallbacks("requestWillFetch"))n=await e({request:n.clone(),event:s})}catch(e){if(e instanceof Error)throw new t("plugin-error-request-will-fetch",{thrownErrorMessage:e.message})}const r=n.clone();try{let e;e=await fetch(n,"navigate"===n.mode?void 0:this._strategy.fetchOptions);for(const t of this.iterateCallbacks("fetchDidSucceed"))e=await t({event:s,request:r,response:e});return e}catch(e){throw a&&await this.runCallbacks("fetchDidFail",{error:e,event:s,originalRequest:a.clone(),request:r.clone()}),e}}async fetchAndCachePut(e){const t=await this.fetch(e),s=t.clone();return this.waitUntil(this.cachePut(e,s)),t}async cacheMatch(e){const t=y(e);let s;const{cacheName:n,matchOptions:a}=this._strategy,r=await this.getCacheKey(t,"read"),i=Object.assign(Object.assign({},a),{cacheName:n});s=await caches.match(r,i);for(const e of this.iterateCallbacks("cachedResponseWillBeUsed"))s=await e({cacheName:n,matchOptions:a,cachedResponse:s,request:r,event:this.event})||void 0;return s}async cachePut(e,s){const n=y(e);await g(0);const a=await this.getCacheKey(n,"write");if(!s)throw new t("cache-put-with-no-response",{url:r(a.url)});const i=await this._ensureResponseSafeToCache(s);if(!i)return!1;const{cacheName:o,matchOptions:c}=this._strategy,h=await self.caches.open(o),u=this.hasCallback("cacheDidUpdate"),l=u?await async function(e,t,s,n){const a=p(t.url,s);if(t.url===a)return e.match(t,n);const r=Object.assign(Object.assign({},n),{ignoreSearch:!0}),i=await e.keys(t,r);for(const t of i)if(a===p(t.url,s))return e.match(t,n)}(h,a.clone(),["__WB_REVISION__"],c):null;try{await h.put(a,u?i.clone():i)}catch(e){if(e instanceof Error)throw"QuotaExceededError"===e.name&&await async function(){for(const e of f)await e()}(),e}for(const e of this.iterateCallbacks("cacheDidUpdate"))await e({cacheName:o,oldResponse:l,newResponse:i.clone(),request:a,event:this.event});return!0}async getCacheKey(e,t){if(!this._cacheKeys[t]){let s=e;for(const e of this.iterateCallbacks("cacheKeyWillBeUsed"))s=y(await e({mode:t,request:s,event:this.event,params:this.params}));this._cacheKeys[t]=s}return this._cacheKeys[t]}hasCallback(e){for(const t of this._strategy.plugins)if(e in t)return!0;return!1}async runCallbacks(e,t){for(const s of this.iterateCallbacks(e))await s(t)}*iterateCallbacks(e){for(const t of this._strategy.plugins)if("function"==typeof t[e]){const s=this._pluginStateMap.get(t),n=n=>{const a=Object.assign(Object.assign({},n),{state:s});return t[e](a)};yield n}}waitUntil(e){return this._extendLifetimePromises.push(e),e}async doneWaiting(){let e;for(;e=this._extendLifetimePromises.shift();)await e}destroy(){this._handlerDeferred.resolve(null)}async _ensureResponseSafeToCache(e){let t=e,s=!1;for(const e of this.iterateCallbacks("cacheWillUpdate"))if(t=await e({request:this.request,response:t,event:this.event})||void 0,s=!0,!t)break;return s||t&&200!==t.status&&(t=void 0),t}}class q{constructor(e={}){this.cacheName=m(e.cacheName),this.plugins=e.plugins||[],this.fetchOptions=e.fetchOptions,this.matchOptions=e.matchOptions}handle(e){const[t]=this.handleAll(e);return t}handleAll(e){e instanceof FetchEvent&&(e={event:e,request:e.request});const t=e.event,s="string"==typeof e.request?new Request(e.request):e.request,n="params"in e?e.params:void 0,a=new b(this,{event:t,request:s,params:n}),r=this._getResponse(a,s,t);return[r,this._awaitComplete(r,a,s,t)]}async _getResponse(e,s,n){let a;await e.runCallbacks("handlerWillStart",{event:n,request:s});try{if(a=await this._handle(s,e),!a||"error"===a.type)throw new t("no-response",{url:s.url})}catch(t){if(t instanceof Error)for(const r of e.iterateCallbacks("handlerDidError"))if(a=await r({error:t,event:n,request:s}),a)break;if(!a)throw t}for(const t of e.iterateCallbacks("handlerWillRespond"))a=await t({event:n,request:s,response:a});return a}async _awaitComplete(e,t,s,n){let a,r;try{a=await e}catch(e){}try{await t.runCallbacks("handlerDidRespond",{event:n,request:s,response:a}),await t.doneWaiting()}catch(e){e instanceof Error&&(r=e)}if(await t.runCallbacks("handlerDidComplete",{event:n,request:s,response:a,error:r}),t.destroy(),r)throw r}}class E extends q{async _handle(e,s){let n,a=await s.cacheMatch(e);if(!a)try{a=await s.fetchAndCachePut(e)}catch(e){e instanceof Error&&(n=e)}if(!a)throw new t("no-response",{url:e.url,error:n});return a}}const x={cacheWillUpdate:async({response:e})=>200===e.status||0===e.status?e:null};class v extends q{constructor(e={}){super(e),this.plugins.some((e=>"cacheWillUpdate"in e))||this.plugins.unshift(x),this._networkTimeoutSeconds=e.networkTimeoutSeconds||0}async _handle(e,s){const n=[],a=[];let r;if(this._networkTimeoutSeconds){const{id:t,promise:i}=this._getTimeoutPromise({request:e,logs:n,handler:s});r=t,a.push(i)}const i=this._getNetworkPromise({timeoutId:r,request:e,logs:n,handler:s});a.push(i);const o=await s.waitUntil((async()=>await s.waitUntil(Promise.race(a))||await i)());if(!o)throw new t("no-response",{url:e.url});return o}_getTimeoutPromise({request:e,logs:t,handler:s}){let n;return{promise:new Promise((t=>{n=setTimeout((async()=>{t(await s.cacheMatch(e))}),1e3*this._networkTimeoutSeconds)})),id:n}}async _getNetworkPromise({timeoutId:e,request:t,logs:s,handler:n}){let a,r;try{r=await n.fetchAndCachePut(t)}catch(e){e instanceof Error&&(a=e)}return e&&clearTimeout(e),!a&&r||(r=await n.cacheMatch(t)),r}}class D extends q{constructor(e={}){super(e),this._networkTimeoutSeconds=e.networkTimeoutSeconds||0}async _handle(e,s){let n,a;try{const t=[s.fetch(e)];if(this._networkTimeoutSeconds){const e=g(1e3*this._networkTimeoutSeconds);t.push(e)}if(a=await Promise.race(t),!a)throw new Error(`Timed out the network response after ${this._networkTimeoutSeconds} seconds.`)}catch(e){e instanceof Error&&(n=e)}if(!a)throw new t("no-response",{url:e.url,error:n});return a}}class R extends q{constructor(e={}){super(e),this.plugins.some((e=>"cacheWillUpdate"in e))||this.plugins.unshift(x)}async _handle(e,s){const n=s.fetchAndCachePut(e).catch((()=>{}));let a,r=await s.cacheMatch(e);if(r);else try{r=await n}catch(e){e instanceof Error&&(a=e)}if(!r)throw new t("no-response",{url:e.url,error:a});return r}}function S(e){e.then((()=>{}))}let k,N;const C=new WeakMap,O=new WeakMap,T=new WeakMap,I=new WeakMap,A=new WeakMap;let L={get(e,t,s){if(e instanceof IDBTransaction){if("done"===t)return O.get(e);if("objectStoreNames"===t)return e.objectStoreNames||T.get(e);if("store"===t)return s.objectStoreNames[1]?void 0:s.objectStore(s.objectStoreNames[0])}return M(e[t])},set:(e,t,s)=>(e[t]=s,!0),has:(e,t)=>e instanceof IDBTransaction&&("done"===t||"store"===t)||t in e};function P(e){return e!==IDBDatabase.prototype.transaction||"objectStoreNames"in IDBTransaction.prototype?(N||(N=[IDBCursor.prototype.advance,IDBCursor.prototype.continue,IDBCursor.prototype.continuePrimaryKey])).includes(e)?function(...t){return e.apply(B(this),t),M(C.get(this))}:function(...t){return M(e.apply(B(this),t))}:function(t,...s){const n=e.call(B(this),t,...s);return T.set(n,t.sort?t.sort():[t]),M(n)}}function j(e){return"function"==typeof e?P(e):(e instanceof IDBTransaction&&function(e){if(O.has(e))return;const t=new Promise(((t,s)=>{const n=()=>{e.removeEventListener("complete",a),e.removeEventListener("error",r),e.removeEventListener("abort",r)},a=()=>{t(),n()},r=()=>{s(e.error||new DOMException("AbortError","AbortError")),n()};e.addEventListener("complete",a),e.addEventListener("error",r),e.addEventListener("abort",r)}));O.set(e,t)}(e),t=e,(k||(k=[IDBDatabase,IDBObjectStore,IDBIndex,IDBCursor,IDBTransaction])).some((e=>t instanceof e))?new Proxy(e,L):e);var t}function M(e){if(e instanceof IDBRequest)return function(e){const t=new Promise(((t,s)=>{const n=()=>{e.removeEventListener("success",a),e.removeEventListener("error",r)},a=()=>{t(M(e.result)),n()},r=()=>{s(e.error),n()};e.addEventListener("success",a),e.addEventListener("error",r)}));return t.then((t=>{t instanceof IDBCursor&&C.set(t,e)})).catch((()=>{})),A.set(t,e),t}(e);if(I.has(e))return I.get(e);const t=j(e);return t!==e&&(I.set(e,t),A.set(t,e)),t}const B=e=>A.get(e);function U(e,t,{blocked:s,upgrade:n,blocking:a,terminated:r}={}){const i=indexedDB.open(e,t),o=M(i);return n&&i.addEventListener("upgradeneeded",(e=>{n(M(i.result),e.oldVersion,e.newVersion,M(i.transaction))})),s&&i.addEventListener("blocked",(()=>s())),o.then((e=>{r&&e.addEventListener("close",(()=>r())),a&&e.addEventListener("versionchange",(()=>a()))})).catch((()=>{})),o}const F=["get","getKey","getAll","getAllKeys","count"],W=["put","add","delete","clear"],H=new Map;function K(e,t){if(!(e instanceof IDBDatabase)||t in e||"string"!=typeof t)return;if(H.get(t))return H.get(t);const s=t.replace(/FromIndex$/,""),n=t!==s,a=W.includes(s);if(!(s in(n?IDBIndex:IDBObjectStore).prototype)||!a&&!F.includes(s))return;const r=async function(e,...t){const r=this.transaction(e,a?"readwrite":"readonly");let i=r.store;return n&&(i=i.index(t.shift())),(await Promise.all([i[s](...t),a&&r.done]))[0]};return H.set(t,r),r}L=(e=>({...e,get:(t,s,n)=>K(t,s)||e.get(t,s,n),has:(t,s)=>!!K(t,s)||e.has(t,s)}))(L);try{self["workbox:expiration:6.2.4"]&&_()}catch(e){}const Q="cache-entries",$=e=>{const t=new URL(e,location.href);return t.hash="",t.href};class G{constructor(e){this._db=null,this._cacheName=e}_upgradeDb(e){const t=e.createObjectStore(Q,{keyPath:"id"});t.createIndex("cacheName","cacheName",{unique:!1}),t.createIndex("timestamp","timestamp",{unique:!1})}_upgradeDbAndDeleteOldDbs(e){this._upgradeDb(e),this._cacheName&&function(e,{blocked:t}={}){const s=indexedDB.deleteDatabase(e);t&&s.addEventListener("blocked",(()=>t())),M(s).then((()=>{}))}(this._cacheName)}async setTimestamp(e,t){const s={url:e=$(e),timestamp:t,cacheName:this._cacheName,id:this._getId(e)},n=(await this.getDb()).transaction(Q,"readwrite",{durability:"relaxed"});await n.store.put(s),await n.done}async getTimestamp(e){const t=await this.getDb(),s=await t.get(Q,this._getId(e));return null==s?void 0:s.timestamp}async expireEntries(e,t){const s=await this.getDb();let n=await s.transaction(Q).store.index("timestamp").openCursor(null,"prev");const a=[];let r=0;for(;n;){const s=n.value;s.cacheName===this._cacheName&&(e&&s.timestamp<e||t&&r>=t?a.push(n.value):r++),n=await n.continue()}const i=[];for(const e of a)await s.delete(Q,e.id),i.push(e.url);return i}_getId(e){return this._cacheName+"|"+$(e)}async getDb(){return this._db||(this._db=await U("workbox-expiration",1,{upgrade:this._upgradeDbAndDeleteOldDbs.bind(this)})),this._db}}class V{constructor(e,t={}){this._isRunning=!1,this._rerunRequested=!1,this._maxEntries=t.maxEntries,this._maxAgeSeconds=t.maxAgeSeconds,this._matchOptions=t.matchOptions,this._cacheName=e,this._timestampModel=new G(e)}async expireEntries(){if(this._isRunning)return void(this._rerunRequested=!0);this._isRunning=!0;const e=this._maxAgeSeconds?Date.now()-1e3*this._maxAgeSeconds:0,t=await this._timestampModel.expireEntries(e,this._maxEntries),s=await self.caches.open(this._cacheName);for(const e of t)await s.delete(e,this._matchOptions);this._isRunning=!1,this._rerunRequested&&(this._rerunRequested=!1,S(this.expireEntries()))}async updateTimestamp(e){await this._timestampModel.setTimestamp(e,Date.now())}async isURLExpired(e){if(this._maxAgeSeconds){const t=await this._timestampModel.getTimestamp(e),s=Date.now()-1e3*this._maxAgeSeconds;return void 0===t||t<s}return!1}async delete(){this._rerunRequested=!1,await this._timestampModel.expireEntries(1/0)}}class J{constructor(e={}){this.cachedResponseWillBeUsed=async({event:e,request:t,cacheName:s,cachedResponse:n})=>{if(!n)return null;const a=this._isResponseDateFresh(n),r=this._getCacheExpiration(s);S(r.expireEntries());const i=r.updateTimestamp(t.url);if(e)try{e.waitUntil(i)}catch(e){}return a?n:null},this.cacheDidUpdate=async({cacheName:e,request:t})=>{const s=this._getCacheExpiration(e);await s.updateTimestamp(t.url),await s.expireEntries()},this._config=e,this._maxAgeSeconds=e.maxAgeSeconds,this._cacheExpirations=new Map,e.purgeOnQuotaError&&function(e){f.add(e)}((()=>this.deleteCacheAndMetadata()))}_getCacheExpiration(e){if(e===m())throw new t("expire-custom-caches-only");let s=this._cacheExpirations.get(e);return s||(s=new V(e,this._config),this._cacheExpirations.set(e,s)),s}_isResponseDateFresh(e){if(!this._maxAgeSeconds)return!0;const t=this._getDateHeaderTimestamp(e);if(null===t)return!0;return t>=Date.now()-1e3*this._maxAgeSeconds}_getDateHeaderTimestamp(e){if(!e.headers.has("date"))return null;const t=e.headers.get("date"),s=new Date(t).getTime();return isNaN(s)?null:s}async deleteCacheAndMetadata(){for(const[e,t]of this._cacheExpirations)await self.caches.delete(e),await t.delete();this._cacheExpirations=new Map}}try{self["workbox:cacheable-response:6.2.4"]&&_()}catch(e){}class z{constructor(e={}){this._statuses=e.statuses,this._headers=e.headers}isResponseCacheable(e){let t=!0;return this._statuses&&(t=this._statuses.includes(e.status)),this._headers&&t&&(t=Object.keys(this._headers).some((t=>e.headers.get(t)===this._headers[t]))),t}}class X{constructor(e){this.cacheWillUpdate=async({response:e})=>this._cacheableResponse.isResponseCacheable(e)?e:null,this._cacheableResponse=new z(e)}}try{self["workbox:background-sync:6.2.4"]&&_()}catch(e){}const Y="requests",Z="queueName";class ee{constructor(){this._db=null}async addEntry(e){const t=(await this.getDb()).transaction(Y,"readwrite",{durability:"relaxed"});await t.store.add(e),await t.done}async getFirstEntryId(){const e=await this.getDb(),t=await e.transaction(Y).store.openCursor();return null==t?void 0:t.value.id}async getAllEntriesByQueueName(e){const t=await this.getDb(),s=await t.getAllFromIndex(Y,Z,IDBKeyRange.only(e));return s||new Array}async deleteEntry(e){const t=await this.getDb();await t.delete(Y,e)}async getFirstEntryByQueueName(e){return await this.getEndEntryFromIndex(IDBKeyRange.only(e),"next")}async getLastEntryByQueueName(e){return await this.getEndEntryFromIndex(IDBKeyRange.only(e),"prev")}async getEndEntryFromIndex(e,t){const s=await this.getDb(),n=await s.transaction(Y).store.index(Z).openCursor(e,t);return null==n?void 0:n.value}async getDb(){return this._db||(this._db=await U("workbox-background-sync",3,{upgrade:this._upgradeDb})),this._db}_upgradeDb(e,t){t>0&&t<3&&e.objectStoreNames.contains(Y)&&e.deleteObjectStore(Y);e.createObjectStore(Y,{autoIncrement:!0,keyPath:"id"}).createIndex(Z,Z,{unique:!1})}}class te{constructor(e){this._queueName=e,this._queueDb=new ee}async pushEntry(e){delete e.id,e.queueName=this._queueName,await this._queueDb.addEntry(e)}async unshiftEntry(e){const t=await this._queueDb.getFirstEntryId();t?e.id=t-1:delete e.id,e.queueName=this._queueName,await this._queueDb.addEntry(e)}async popEntry(){return this._removeEntry(await this._queueDb.getLastEntryByQueueName(this._queueName))}async shiftEntry(){return this._removeEntry(await this._queueDb.getFirstEntryByQueueName(this._queueName))}async getAll(){return await this._queueDb.getAllEntriesByQueueName(this._queueName)}async deleteEntry(e){await this._queueDb.deleteEntry(e)}async _removeEntry(e){return e&&await this.deleteEntry(e.id),e}}const se=["method","referrer","referrerPolicy","mode","credentials","cache","redirect","integrity","keepalive"];class ne{constructor(e){"navigate"===e.mode&&(e.mode="same-origin"),this._requestData=e}static async fromRequest(e){const t={url:e.url,headers:{}};"GET"!==e.method&&(t.body=await e.clone().arrayBuffer());for(const[s,n]of e.headers.entries())t.headers[s]=n;for(const s of se)void 0!==e[s]&&(t[s]=e[s]);return new ne(t)}toObject(){const e=Object.assign({},this._requestData);return e.headers=Object.assign({},this._requestData.headers),e.body&&(e.body=e.body.slice(0)),e}toRequest(){return new Request(this._requestData.url,this._requestData)}clone(){return new ne(this.toObject())}}const ae=new Set,re=e=>{const t={request:new ne(e.requestData).toRequest(),timestamp:e.timestamp};return e.metadata&&(t.metadata=e.metadata),t};class ie{constructor(e,{onSync:s,maxRetentionTime:n}={}){if(this._syncInProgress=!1,this._requestsAddedDuringSync=!1,ae.has(e))throw new t("duplicate-queue-name",{name:e});ae.add(e),this._name=e,this._onSync=s||this.replayRequests,this._maxRetentionTime=n||10080,this._queueStore=new te(this._name),this._addSyncListener()}get name(){return this._name}async pushRequest(e){await this._addRequest(e,"push")}async unshiftRequest(e){await this._addRequest(e,"unshift")}async popRequest(){return this._removeRequest("pop")}async shiftRequest(){return this._removeRequest("shift")}async getAll(){const e=await this._queueStore.getAll(),t=Date.now(),s=[];for(const n of e){const e=6e4*this._maxRetentionTime;t-n.timestamp>e?await this._queueStore.deleteEntry(n.id):s.push(re(n))}return s}async _addRequest({request:e,metadata:t,timestamp:s=Date.now()},n){const a={requestData:(await ne.fromRequest(e.clone())).toObject(),timestamp:s};t&&(a.metadata=t),await this._queueStore[`${n}Entry`](a),this._syncInProgress?this._requestsAddedDuringSync=!0:await this.registerSync()}async _removeRequest(e){const t=Date.now(),s=await this._queueStore[`${e}Entry`]();if(s){const n=6e4*this._maxRetentionTime;return t-s.timestamp>n?this._removeRequest(e):re(s)}}async replayRequests(){let e;for(;e=await this.shiftRequest();)try{await fetch(e.request.clone())}catch(s){throw await this.unshiftRequest(e),new t("queue-replay-failed",{name:this._name})}}async registerSync(){if("sync"in self.registration)try{await self.registration.sync.register(`workbox-background-sync:${this._name}`)}catch(e){}}_addSyncListener(){"sync"in self.registration?self.addEventListener("sync",(e=>{if(e.tag===`workbox-background-sync:${this._name}`){const t=async()=>{let t;this._syncInProgress=!0;try{await this._onSync({queue:this})}catch(e){if(e instanceof Error)throw t=e,t}finally{!this._requestsAddedDuringSync||t&&!e.lastChance||await this.registerSync(),this._syncInProgress=!1,this._requestsAddedDuringSync=!1}};e.waitUntil(t())}})):this._onSync({queue:this})}static get _queueNames(){return ae}}class oe{constructor(e,t){this.fetchDidFail=async({request:e})=>{await this._queue.pushRequest({request:e})},this._queue=new ie(e,t)}}try{self["workbox:google-analytics:6.2.4"]&&_()}catch(e){}const ce="www.google-analytics.com",he="www.googletagmanager.com",ue=/^\/(\w+\/)?collect/,le=e=>{const t=({url:e})=>e.hostname===ce&&ue.test(e.pathname),s=new D({plugins:[e]});return[new n(t,s,"GET"),new n(t,s,"POST")]},de=e=>{const t=new v({cacheName:e});return new n((({url:e})=>e.hostname===ce&&"/analytics.js"===e.pathname),t,"GET")},me=e=>{const t=new v({cacheName:e});return new n((({url:e})=>e.hostname===he&&"/gtag/js"===e.pathname),t,"GET")},pe=e=>{const t=new v({cacheName:e});return new n((({url:e})=>e.hostname===he&&"/gtm.js"===e.pathname),t,"GET")};((e={})=>{const t=d(e.cacheName),s=new oe("workbox-google-analytics",{maxRetentionTime:2880,onSync:(n=e,async({queue:e})=>{let t;for(;t=await e.shiftRequest();){const{request:s,timestamp:a}=t,r=new URL(s.url);try{const e="POST"===s.method?new URLSearchParams(await s.clone().text()):r.searchParams,t=a-(Number(e.get("qt"))||0),i=Date.now()-t;if(e.set("qt",String(i)),n.parameterOverrides)for(const t of Object.keys(n.parameterOverrides)){const s=n.parameterOverrides[t];e.set(t,s)}"function"==typeof n.hitFilter&&n.hitFilter.call(null,e),await fetch(new Request(r.origin+r.pathname,{body:e.toString(),method:"POST",mode:"cors",credentials:"omit",headers:{"Content-Type":"text/plain"}}))}catch(s){throw await e.unshiftRequest(t),s}}})});var n;const a=[pe(t),de(t),me(t),...le(s)],r=new i;for(const e of a)r.registerRoute(e);r.addFetchListener()})(),h((({request:e})=>"navigate"===e.mode),new v({cacheName:"index"})),h((({request:e})=>"style"===e.destination||"script"===e.destination),new R({cacheName:"static-resources",plugins:[new J({maxAgeSeconds:2592e3,purgeOnQuotaError:!0})]})),h((({request:e})=>"image"===e.destination),new E({cacheName:"images",plugins:[new J({maxEntries:60,maxAgeSeconds:2592e3,purgeOnQuotaError:!0}),new X({statuses:[0,200]})]})),h(/.*api\.mapbox\.com\/fonts/,new E({cacheName:"mapbox-fonts",plugins:[new J({maxEntries:10,purgeOnQuotaError:!0}),new X({statuses:[0,200]})]})),h(/.*(?:tiles\.mapbox|api\.mapbox)\.com.*$/,new R({cacheName:"mapbox",plugins:[new J({maxAgeSeconds:2592e3,purgeOnQuotaError:!0}),new X({statuses:[0,200]})]}))}();
//# sourceMappingURL=sw.js.map
