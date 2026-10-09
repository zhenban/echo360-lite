// ===================================================================================
// The shapes of the data passed between the parts, for readers and for the type checker
// (npm run typecheck). Comments only: nothing here runs.
// ===================================================================================

/**
 * One view of the recording (screen or camera), from the page (10-adapter-echo360.js).
 * @typedef {object} Source
 * @property {number} index        Echo360's sourceIndex (1, 2...)
 * @property {number} n            position, from 1
 * @property {string|null} av      HLS master playlist with audio and video
 * @property {string|null} v       HLS master playlist with video only
 * @property {string|null} poster  picture shown before playback
 */

/**
 * Echo360's preview pictures of one view, one per minute.
 * @typedef {object} ThumbnailSet
 * @property {number} sourceIndex
 * @property {string} baseUri
 * @property {string} extension
 * @property {number[]} timesInSeconds
 */

/**
 * The recording, as the player sees it (echo360ClassroomAdapter.parse).
 * @typedef {object} Lesson
 * @property {string} id                 the media id (or lesson id, or the page path)
 * @property {string} [lessonId]
 * @property {string|null} sectionId     the course
 * @property {string} [mediaId]
 * @property {string|null} userId
 * @property {boolean} isAnonymousUser
 * @property {string|null} transcriptUrl
 * @property {string} title
 * @property {string} courseName
 * @property {number|null} sessionRenewMs   how often Echo360 renews video access
 * @property {string|null} backUrl
 * @property {number} duration           seconds (NaN if unknown)
 * @property {number|null} resumeAt      seconds: where Echo360 says playback stopped
 * @property {Source[]} sources
 * @property {string|null} captionsUrl
 * @property {ThumbnailSet[]} thumbnails
 * @property {{ polls: boolean, slides: boolean, audioDescription: boolean }} extras
 * @property {object|null} analytics     what watch reporting needs (20-reporter.js)
 */

/**
 * A line of the transcript or captions (seconds).
 * @typedef {object} Cue
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {string} speaker
 */

/**
 * A slide chapter found in the screen view (64-slides.js).
 * @typedef {object} Chapter
 * @property {number} start       seconds
 * @property {number} end         seconds
 * @property {boolean} precise    start pinned to about a second (else to a sample)
 * @property {number} repTime     the moment whose picture represents it
 * @property {string} thumb       picture URL (object URL or Echo360 preview)
 * @property {Blob|null} [blob]   the picture, when made from a keyframe
 * @property {number} [firstSample]
 */

/**
 * A stretch that can be skipped (62-silence.js skipStretches).
 * @typedef {object} SkipStretch
 * @property {number} start
 * @property {number} end
 * @property {'silence'|'blank'|'black'} kind
 */

/**
 * A page of the lecturer's slide files (68-slide-deck.js).
 * @typedef {object} DeckPage
 * @property {string} key     file hash (12 characters) + ':' + page number
 * @property {string} file    file name
 * @property {number} num     page number, from 1
 * @property {object} doc     the pdf.js document
 * @property {number} ar      height / width
 * @property {string} title
 * @property {string} text
 */

/**
 * A note, bookmark or "didn't understand" flag (11-echo360-api.js).
 * @typedef {object} Note
 * @property {string} id
 * @property {'note'|'bookmark'|'flag'} type
 * @property {number|null} time   seconds
 * @property {string} [text]
 * @property {string} createdAt
 */

/**
 * A discussion post or reply (11-echo360-api.js).
 * @typedef {object} DiscussionComment
 * @property {string} id
 * @property {string|null} questionId   null for a post, the post for a reply
 * @property {string} body
 * @property {number|null} time
 * @property {string} author
 * @property {boolean} mine
 * @property {number} likes
 * @property {boolean} liked
 * @property {boolean} saved
 * @property {boolean} hasAttachment
 * @property {DiscussionComment[]} replies
 */

// ---- stored in IndexedDB (61-media-io.js idbCache), by key prefix ----
// Analysis results (pruned, see 63-caches.js); user data (kept, in backups, 85-export.js).

/**
 * slides:<mediaId>  (analysis)
 * @typedef {object} SlidesRecord
 * @property {number} v           CACHE_KINDS.slides
 * @property {number} used        last use (ms)
 * @property {number|null} screen the screen view's index
 * @property {boolean} [sure]     the screen view was told clearly (not a guess)
 * @property {{ start: number, end: number }[]} uniform   empty-screen stretches
 * @property {Chapter[]} chapters
 */

/**
 * silence-env:<mediaId>  (analysis)
 * @typedef {object} SilenceEnvRecord
 * @property {number} v
 * @property {number} used
 * @property {number} step        seconds per value
 * @property {Uint8Array} data    0 = not analysed, 1..255 = -100..0 dBFS
 */

/**
 * ocr:<mediaId>:<view>[:<language>]  (analysis)
 * @typedef {object} OcrRecord
 * @property {number} v
 * @property {number} used
 * @property {number} screen
 * @property {number} height      rendition read
 * @property {string[]} texts     each distinct picture's text
 * @property {number[]} at        per sample: index into texts, -1 = not read
 * @property {object} stats
 */

/**
 * watched:<lessonId>  (user data)
 * @typedef {object} WatchedRecord
 * @property {number} d           duration (s)
 * @property {[number, number][]} r   watched stretches (s)
 * @property {number} [e]         where the content ends (an empty ending follows)
 * @property {number} at          last update (ms)
 */

// Other user data:
//   tags:<sectionId>     { tags: [{ id, name, color }] }
//   tagmap:<mediaId>     { <note or bookmark id>: [tag id] }
//   deck:<mediaId>       { files: [{ hash, name }], fixes: [{ a, b, page }] }
//   deckref:<hash>       [mediaId]   recordings using a slide file
//   deckfile:<hash>      Blob        the slide file
//   screenpick:<mediaId> { index }   the screen view chosen by hand
// localStorage (prefix lite-player-for-echo360:): prefs (39-prefs.js), pos:<lesson id> { t, at },
// debug, dryRun, forceOriginal, silenceFromAudio (development switches).
