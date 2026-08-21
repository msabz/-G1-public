package com.m200.service

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class G1ContactModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val SOURCE_MANUAL = "MANUAL_NUMBER"
        private const val SOURCE_QR = "QR_FULL_ID"
    }

    private class DbHelper(context: Context) : SQLiteOpenHelper(context, "g1_identity.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS g1_contacts (
                    g1_number TEXT PRIMARY KEY,
                    user_id TEXT,
                    profile_name TEXT NOT NULL DEFAULT '',
                    local_alias TEXT NOT NULL DEFAULT '',
                    source TEXT NOT NULL,
                    human_verified INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """.trimIndent()
            )
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_g1_contacts_user_id ON g1_contacts(user_id)")
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    }

    private val helper = DbHelper(reactContext)

    override fun getName() = "G1ContactModule"

    private data class ExistingContact(
        val userId: String?,
        val profileName: String,
        val localAlias: String,
        val source: String,
        val createdAt: Long,
    )

    private fun getExisting(db: SQLiteDatabase, g1Number: String): ExistingContact? {
        db.rawQuery(
            "SELECT user_id, profile_name, local_alias, source, created_at FROM g1_contacts WHERE g1_number = ? LIMIT 1",
            arrayOf(g1Number)
        ).use { cursor ->
            if (!cursor.moveToFirst()) return null
            return ExistingContact(
                userId = if (cursor.isNull(0)) null else cursor.getString(0),
                profileName = cursor.getString(1) ?: "",
                localAlias = cursor.getString(2) ?: "",
                source = cursor.getString(3) ?: SOURCE_MANUAL,
                createdAt = cursor.getLong(4),
            )
        }
    }

    @ReactMethod
    fun upsertContact(
        g1Number: String,
        userId: String?,
        profileName: String?,
        localAlias: String?,
        source: String,
        promise: Promise,
    ) {
        try {
            val normalizedNumber = G1IdentityFormat.normalizeG1Number(g1Number)
                ?: throw IllegalArgumentException("Invalid G1 Number")
            val normalizedUserId = userId?.takeIf { it.isNotBlank() }?.let {
                G1IdentityFormat.normalizeUserId(it)
                    ?: throw IllegalArgumentException("Invalid full G1 userId")
            }
            if (normalizedUserId != null && !G1IdentityFormat.matches(normalizedNumber, normalizedUserId)) {
                throw IllegalArgumentException("G1 Number does not match full userId")
            }
            require(source == SOURCE_MANUAL || source == SOURCE_QR) { "Unsupported G1 contact source" }
            if (source == SOURCE_QR) require(normalizedUserId != null) { "QR contact requires full userId" }

            val db = helper.writableDatabase
            val existing = getExisting(db, normalizedNumber)
            if (existing?.userId != null && normalizedUserId != null && existing.userId != normalizedUserId) {
                throw SecurityException("Stored G1 contact has a conflicting full user identity")
            }

            val now = System.currentTimeMillis()
            val effectiveUserId = normalizedUserId ?: existing?.userId
            val effectiveProfile = profileName?.trim()?.take(80)?.takeIf { it.isNotEmpty() }
                ?: existing?.profileName.orEmpty()
            val effectiveAlias = localAlias?.trim()?.take(80)?.takeIf { it.isNotEmpty() }
                ?: existing?.localAlias.orEmpty()
            val effectiveSource = if (effectiveUserId != null) SOURCE_QR else SOURCE_MANUAL

            val values = ContentValues().apply {
                put("g1_number", normalizedNumber)
                if (effectiveUserId == null) putNull("user_id") else put("user_id", effectiveUserId)
                put("profile_name", effectiveProfile)
                put("local_alias", effectiveAlias)
                put("source", effectiveSource)
                put("human_verified", 0)
                put("created_at", existing?.createdAt ?: now)
                put("updated_at", now)
            }
            db.insertWithOnConflict("g1_contacts", null, values, SQLiteDatabase.CONFLICT_REPLACE)
            promise.resolve(contactMap(normalizedNumber, effectiveUserId, effectiveProfile, effectiveAlias, effectiveSource, existing?.createdAt ?: now, now))
        } catch (e: SecurityException) {
            promise.reject("G1_CONTACT_IDENTITY_CONFLICT", e.message, e)
        } catch (e: Exception) {
            promise.reject("G1_CONTACT_ERROR", e.message, e)
        }
    }

    private fun contactMap(
        g1Number: String,
        userId: String?,
        profileName: String,
        localAlias: String,
        source: String,
        createdAt: Long,
        updatedAt: Long,
    ) = Arguments.createMap().apply {
        putString("g1Number", g1Number)
        if (userId == null) putNull("userId") else putString("userId", userId)
        putString("profileName", profileName)
        putString("localAlias", localAlias)
        putString("source", source)
        putBoolean("humanVerified", false)
        putDouble("createdAt", createdAt.toDouble())
        putDouble("updatedAt", updatedAt.toDouble())
    }

    @ReactMethod
    fun listContacts(promise: Promise) {
        try {
            val arr = Arguments.createArray()
            helper.readableDatabase.rawQuery(
                "SELECT g1_number, user_id, profile_name, local_alias, source, human_verified, created_at, updated_at FROM g1_contacts ORDER BY updated_at DESC",
                null
            ).use { cursor ->
                while (cursor.moveToNext()) {
                    arr.pushMap(Arguments.createMap().apply {
                        putString("g1Number", cursor.getString(0))
                        if (cursor.isNull(1)) putNull("userId") else putString("userId", cursor.getString(1))
                        putString("profileName", cursor.getString(2) ?: "")
                        putString("localAlias", cursor.getString(3) ?: "")
                        putString("source", cursor.getString(4) ?: SOURCE_MANUAL)
                        putBoolean("humanVerified", cursor.getInt(5) != 0)
                        putDouble("createdAt", cursor.getLong(6).toDouble())
                        putDouble("updatedAt", cursor.getLong(7).toDouble())
                    })
                }
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("G1_CONTACT_LIST_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun deleteContact(g1Number: String, promise: Promise) {
        try {
            val normalizedNumber = G1IdentityFormat.normalizeG1Number(g1Number)
                ?: throw IllegalArgumentException("Invalid G1 Number")
            val count = helper.writableDatabase.delete("g1_contacts", "g1_number = ?", arrayOf(normalizedNumber))
            promise.resolve(count > 0)
        } catch (e: Exception) {
            promise.reject("G1_CONTACT_DELETE_ERROR", e.message, e)
        }
    }
}
