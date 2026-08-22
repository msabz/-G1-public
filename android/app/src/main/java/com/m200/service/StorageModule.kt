package com.m200.service

import android.content.ContentValues
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.facebook.react.bridge.*
import java.util.UUID

/**
 * Durable local application storage for G1 conversations and call history.
 *
 * Schema upgrades are strictly additive. Older builds used DROP TABLE during
 * onUpgrade(), which meant adding a feature could erase every conversation.
 * From v3 onward migrations must preserve user data.
 */
class StorageModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    private val helper = DbHelper(reactContext)

    override fun getName() = "StorageModule"

    class DbHelper(context: Context) : SQLiteOpenHelper(context, "musabchat.db", null, 5) {
        override fun onCreate(db: SQLiteDatabase) {
            createMessagesTable(db)
            createPeersTable(db)
            createCallRecordsTable(db)
            createIndexes(db)
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            db.beginTransaction()
            try {
                // v1/v2 installations already contain messages + peers. Never
                // drop them. Add only the columns/tables required by v3.
                if (oldVersion < 3) {
                    addColumnIfMissing(db, "messages", "message_id", "TEXT")
                    addColumnIfMissing(db, "messages", "reply_to_message_id", "TEXT")
                    addColumnIfMissing(db, "messages", "edited_at", "INTEGER")
                    addColumnIfMissing(db, "messages", "deleted", "INTEGER NOT NULL DEFAULT 0")
                    createCallRecordsTable(db)
                    createIndexes(db)
                }
                if (oldVersion < 4) {
                    // v3 added message_id, but rows created by older builds can
                    // still contain NULL. Give every legacy row a deterministic
                    // local id so reply and local-delete actions survive restart.
                    addColumnIfMissing(db, "messages", "message_id", "TEXT")
                    db.execSQL(
                        "UPDATE messages SET message_id = 'legacy-' || CAST(id AS TEXT) " +
                            "WHERE message_id IS NULL OR message_id = ''"
                    )
                    createIndexes(db)
                }
                if (oldVersion < 5) {
                    addColumnIfMissing(db, "peers", "bluetooth_address", "TEXT")
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        }

        private fun createMessagesTable(db: SQLiteDatabase) {
            db.execSQL("""
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    message_id TEXT,
                    peer_id TEXT NOT NULL,
                    sender TEXT NOT NULL,
                    type TEXT NOT NULL,
                    text TEXT,
                    file_name TEXT,
                    mime_type TEXT,
                    path TEXT,
                    local_uri TEXT,
                    size INTEGER DEFAULT 0,
                    status TEXT,
                    reply_to_message_id TEXT,
                    edited_at INTEGER,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    time INTEGER NOT NULL
                )
            """.trimIndent())
        }

        private fun createPeersTable(db: SQLiteDatabase) {
            db.execSQL("""
                CREATE TABLE IF NOT EXISTS peers (
                    peer_id TEXT PRIMARY KEY,
                    name TEXT,
                    device_address TEXT,
                    bluetooth_address TEXT,
                    custom_name TEXT,
                    last_seen INTEGER,
                    last_message TEXT
                )
            """.trimIndent())
        }

        private fun createCallRecordsTable(db: SQLiteDatabase) {
            db.execSQL("""
                CREATE TABLE IF NOT EXISTS call_records (
                    call_id TEXT PRIMARY KEY,
                    peer_id TEXT NOT NULL,
                    peer_name TEXT,
                    direction TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    started_at INTEGER NOT NULL,
                    answered_at INTEGER,
                    ended_at INTEGER,
                    duration INTEGER NOT NULL DEFAULT 0,
                    final_state TEXT NOT NULL,
                    end_reason TEXT
                )
            """.trimIndent())
        }

        private fun createIndexes(db: SQLiteDatabase) {
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_peer_time ON messages(peer_id, time)")
            db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS idx_peer_message_id ON messages(peer_id, message_id) WHERE message_id IS NOT NULL")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_call_started ON call_records(started_at DESC)")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_call_peer_started ON call_records(peer_id, started_at DESC)")
        }

        private fun hasColumn(db: SQLiteDatabase, table: String, column: String): Boolean {
            db.rawQuery("PRAGMA table_info($table)", null).use { cursor ->
                val nameIndex = cursor.getColumnIndex("name")
                while (cursor.moveToNext()) {
                    if (nameIndex >= 0 && cursor.getString(nameIndex) == column) return true
                }
            }
            return false
        }

        private fun addColumnIfMissing(db: SQLiteDatabase, table: String, column: String, definition: String) {
            if (!hasColumn(db, table, column)) {
                db.execSQL("ALTER TABLE $table ADD COLUMN $column $definition")
            }
        }
    }

    private fun ReadableMap.getStringOr(key: String, def: String?): String? =
        if (hasKey(key) && !isNull(key)) getString(key) else def

    private fun ReadableMap.getLongOr(key: String, def: Long?): Long? =
        if (hasKey(key) && !isNull(key)) getDouble(key).toLong() else def

    @ReactMethod
    fun saveMessage(peerId: String, message: ReadableMap, promise: Promise) {
        try {
            val db = helper.writableDatabase
            val messageId = message.getStringOr("messageId", null) ?: UUID.randomUUID().toString()
            val values = ContentValues().apply {
                put("message_id", messageId)
                put("peer_id", peerId)
                put("sender", message.getStringOr("sender", "me"))
                put("type", message.getStringOr("type", "text"))
                put("text", message.getStringOr("text", null))
                put("file_name", message.getStringOr("fileName", null))
                put("mime_type", message.getStringOr("mimeType", null))
                put("path", message.getStringOr("path", null))
                put("local_uri", message.getStringOr("localUri", null))
                put("size", message.getLongOr("size", 0L) ?: 0L)
                put("status", message.getStringOr("status", null))
                put("reply_to_message_id", message.getStringOr("replyToMessageId", null))
                val editedAt = message.getLongOr("editedAt", null)
                if (editedAt == null) putNull("edited_at") else put("edited_at", editedAt)
                put("deleted", 0)
                put("time", message.getLongOr("time", System.currentTimeMillis()) ?: System.currentTimeMillis())
            }
            var id = db.insertWithOnConflict("messages", null, values, SQLiteDatabase.CONFLICT_IGNORE)
            if (id == -1L) {
                db.rawQuery(
                    "SELECT id FROM messages WHERE peer_id = ? AND message_id = ? LIMIT 1",
                    arrayOf(peerId, messageId)
                ).use { cursor ->
                    if (cursor.moveToFirst()) id = cursor.getLong(0)
                }
            }
            promise.resolve(Arguments.createMap().apply {
                putDouble("rowId", id.toDouble())
                putString("messageId", messageId)
            })
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun loadMessages(peerId: String, limit: Int, promise: Promise) {
        try {
            val safeLimit = limit.coerceIn(1, 5000)
            val db = helper.readableDatabase
            val cursor = db.rawQuery(
                "SELECT * FROM (SELECT * FROM messages WHERE peer_id = ? AND deleted = 0 ORDER BY time DESC LIMIT ?) ORDER BY time ASC",
                arrayOf(peerId, safeLimit.toString())
            )
            val arr = Arguments.createArray()
            cursor.use { c ->
                while (c.moveToNext()) {
                    arr.pushMap(Arguments.createMap().apply {
                        putString("messageId", c.getString(c.getColumnIndexOrThrow("message_id")))
                        putString("sender", c.getString(c.getColumnIndexOrThrow("sender")))
                        putString("type", c.getString(c.getColumnIndexOrThrow("type")))
                        putString("text", c.getString(c.getColumnIndexOrThrow("text")))
                        putString("fileName", c.getString(c.getColumnIndexOrThrow("file_name")))
                        putString("mimeType", c.getString(c.getColumnIndexOrThrow("mime_type")))
                        putString("path", c.getString(c.getColumnIndexOrThrow("path")))
                        putString("localUri", c.getString(c.getColumnIndexOrThrow("local_uri")))
                        putDouble("size", c.getLong(c.getColumnIndexOrThrow("size")).toDouble())
                        putString("status", c.getString(c.getColumnIndexOrThrow("status")))
                        putString("replyToMessageId", c.getString(c.getColumnIndexOrThrow("reply_to_message_id")))
                        val editedIndex = c.getColumnIndexOrThrow("edited_at")
                        if (c.isNull(editedIndex)) putNull("editedAt") else putDouble("editedAt", c.getLong(editedIndex).toDouble())
                        putDouble("time", c.getLong(c.getColumnIndexOrThrow("time")).toDouble())
                    })
                }
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun clearMessages(peerId: String, promise: Promise) {
        try {
            helper.writableDatabase.delete("messages", "peer_id = ?", arrayOf(peerId))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun deleteMessageLocal(peerId: String, messageId: String, promise: Promise) {
        try {
            val count = helper.writableDatabase.delete(
                "messages",
                "peer_id = ? AND message_id = ?",
                arrayOf(peerId, messageId)
            )
            promise.resolve(count > 0)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun markMessageDeleted(peerId: String, messageId: String, promise: Promise) {
        try {
            val values = ContentValues().apply {
                put("deleted", 1)
                putNull("text")
                putNull("path")
                putNull("local_uri")
            }
            val count = helper.writableDatabase.update(
                "messages",
                values,
                "peer_id = ? AND message_id = ?",
                arrayOf(peerId, messageId)
            )
            promise.resolve(count > 0)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun updateMessageStatus(peerId: String, messageId: String, status: String, promise: Promise) {
        try {
            val values = ContentValues().apply { put("status", status) }
            val count = helper.writableDatabase.update(
                "messages", values, "peer_id = ? AND message_id = ?", arrayOf(peerId, messageId)
            )
            promise.resolve(count > 0)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun editMessage(peerId: String, messageId: String, text: String, editedAt: Double, promise: Promise) {
        try {
            val values = ContentValues().apply {
                put("text", text)
                put("edited_at", editedAt.toLong())
            }
            val count = helper.writableDatabase.update(
                "messages", values, "peer_id = ? AND message_id = ?", arrayOf(peerId, messageId)
            )
            promise.resolve(count > 0)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun savePeer(peerId: String, name: String, lastMessage: String, promise: Promise) {
        try {
            val db = helper.writableDatabase
            val values = ContentValues().apply {
                put("peer_id", peerId)
                put("name", name)
                put("last_seen", System.currentTimeMillis())
                if (lastMessage.isNotEmpty()) put("last_message", lastMessage)
            }
            val updated = db.update("peers", values, "peer_id = ?", arrayOf(peerId))
            if (updated == 0) {
                db.insertWithOnConflict("peers", null, values, SQLiteDatabase.CONFLICT_REPLACE)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun savePeerAddress(peerId: String, deviceAddress: String, deviceName: String, promise: Promise) {
        try {
            val db = helper.writableDatabase
            val values = ContentValues().apply {
                put("peer_id", peerId)
                put("device_address", deviceAddress)
                put("name", deviceName)
                put("last_seen", System.currentTimeMillis())
            }
            val updated = db.update("peers", values, "peer_id = ?", arrayOf(peerId))
            if (updated == 0) {
                db.insertWithOnConflict("peers", null, values, SQLiteDatabase.CONFLICT_REPLACE)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun savePeerBluetoothAddress(
        peerId: String,
        bluetoothAddress: String,
        deviceName: String,
        promise: Promise,
    ) {
        try {
            val db = helper.writableDatabase
            val values = ContentValues().apply {
                put("peer_id", peerId)
                put("bluetooth_address", bluetoothAddress)
                put("name", deviceName)
                put("last_seen", System.currentTimeMillis())
            }
            val updated = db.update("peers", values, "peer_id = ?", arrayOf(peerId))
            if (updated == 0) {
                db.insertWithOnConflict("peers", null, values, SQLiteDatabase.CONFLICT_REPLACE)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun deletePeer(peerId: String, promise: Promise) {
        try {
            val db = helper.writableDatabase
            db.delete("messages", "peer_id = ?", arrayOf(peerId))
            db.delete("peers", "peer_id = ?", arrayOf(peerId))
            // Call history is intentionally independent from conversation
            // deletion. Users can clear/delete call records separately.
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun listPeers(promise: Promise) {
        try {
            val cursor = helper.readableDatabase.rawQuery(
                "SELECT * FROM peers ORDER BY last_seen DESC", null
            )
            val arr = Arguments.createArray()
            cursor.use { c ->
                while (c.moveToNext()) {
                    arr.pushMap(Arguments.createMap().apply {
                        putString("peerId", c.getString(c.getColumnIndexOrThrow("peer_id")))
                        putString("name", c.getString(c.getColumnIndexOrThrow("name")))
                        putString("deviceAddress", c.getString(c.getColumnIndexOrThrow("device_address")))
                        putString("btAddress", c.getString(c.getColumnIndexOrThrow("bluetooth_address")))
                        putString("customName", c.getString(c.getColumnIndexOrThrow("custom_name")))
                        putDouble("lastSeen", c.getLong(c.getColumnIndexOrThrow("last_seen")).toDouble())
                        putString("lastMessage", c.getString(c.getColumnIndexOrThrow("last_message")))
                    })
                }
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun saveCallRecord(record: ReadableMap, promise: Promise) {
        try {
            val callId = record.getStringOr("callId", null) ?: UUID.randomUUID().toString()
            val peerId = record.getStringOr("peerId", null)
                ?: throw IllegalArgumentException("peerId is required for call record")
            val db = helper.writableDatabase
            val values = ContentValues().apply {
                put("call_id", callId)
                put("peer_id", peerId)
                put("peer_name", record.getStringOr("peerName", null))
                put("direction", record.getStringOr("direction", "incoming"))
                put("media_type", record.getStringOr("mediaType", "voice"))
                put("started_at", record.getLongOr("startedAt", System.currentTimeMillis()) ?: System.currentTimeMillis())
                val answeredAt = record.getLongOr("answeredAt", null)
                if (answeredAt == null) putNull("answered_at") else put("answered_at", answeredAt)
                val endedAt = record.getLongOr("endedAt", null)
                if (endedAt == null) putNull("ended_at") else put("ended_at", endedAt)
                put("duration", record.getLongOr("duration", 0L) ?: 0L)
                put("final_state", record.getStringOr("finalState", "ringing"))
                put("end_reason", record.getStringOr("endReason", null))
            }
            val updated = db.update("call_records", values, "call_id = ?", arrayOf(callId))
            if (updated == 0) {
                db.insertOrThrow("call_records", null, values)
            }
            promise.resolve(callId)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun listCallRecords(limit: Int, promise: Promise) {
        try {
            val safeLimit = limit.coerceIn(1, 5000)
            val cursor = helper.readableDatabase.rawQuery(
                "SELECT * FROM call_records ORDER BY started_at DESC LIMIT ?",
                arrayOf(safeLimit.toString())
            )
            val arr = Arguments.createArray()
            cursor.use { c ->
                while (c.moveToNext()) {
                    arr.pushMap(Arguments.createMap().apply {
                        putString("callId", c.getString(c.getColumnIndexOrThrow("call_id")))
                        putString("peerId", c.getString(c.getColumnIndexOrThrow("peer_id")))
                        putString("peerName", c.getString(c.getColumnIndexOrThrow("peer_name")))
                        putString("direction", c.getString(c.getColumnIndexOrThrow("direction")))
                        putString("mediaType", c.getString(c.getColumnIndexOrThrow("media_type")))
                        putDouble("startedAt", c.getLong(c.getColumnIndexOrThrow("started_at")).toDouble())
                        val answeredIndex = c.getColumnIndexOrThrow("answered_at")
                        if (c.isNull(answeredIndex)) putNull("answeredAt") else putDouble("answeredAt", c.getLong(answeredIndex).toDouble())
                        val endedIndex = c.getColumnIndexOrThrow("ended_at")
                        if (c.isNull(endedIndex)) putNull("endedAt") else putDouble("endedAt", c.getLong(endedIndex).toDouble())
                        putDouble("duration", c.getLong(c.getColumnIndexOrThrow("duration")).toDouble())
                        putString("finalState", c.getString(c.getColumnIndexOrThrow("final_state")))
                        putString("endReason", c.getString(c.getColumnIndexOrThrow("end_reason")))
                    })
                }
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun deleteCallRecord(callId: String, promise: Promise) {
        try {
            val count = helper.writableDatabase.delete("call_records", "call_id = ?", arrayOf(callId))
            promise.resolve(count > 0)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun clearCallHistory(promise: Promise) {
        try {
            helper.writableDatabase.delete("call_records", null, null)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun copyText(text: String, promise: Promise) {
        try {
            val clipboard = reactApplicationContext
                .getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("DirectChat message", text))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getThemeMode(promise: Promise) {
        try {
            val mode = reactApplicationContext
                .getSharedPreferences("directchat_ui", Context.MODE_PRIVATE)
                .getString("theme_mode", "system")
            promise.resolve(mode)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun setThemeMode(mode: String, promise: Promise) {
        try {
            require(mode == "system" || mode == "light" || mode == "dark") {
                "theme mode must be system, light, or dark"
            }
            reactApplicationContext
                .getSharedPreferences("directchat_ui", Context.MODE_PRIVATE)
                .edit()
                .putString("theme_mode", mode)
                .apply()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getDeviceIdentity(promise: Promise) {
        try {
            val prefs = reactApplicationContext.getSharedPreferences("musabchat_identity", Context.MODE_PRIVATE)
            var id = prefs.getString("device_id", null)
            if (id == null) {
                id = UUID.randomUUID().toString()
                prefs.edit().putString("device_id", id).apply()
            }
            val name = prefs.getString("device_name", android.os.Build.MODEL ?: "جهاز")
            promise.resolve(Arguments.createMap().apply {
                putString("deviceId", id)
                putString("deviceName", name)
            })
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun setDeviceName(name: String, promise: Promise) {
        try {
            reactApplicationContext
                .getSharedPreferences("musabchat_identity", Context.MODE_PRIVATE)
                .edit().putString("device_name", name).apply()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("ERROR", e.message, e)
        }
    }
}
