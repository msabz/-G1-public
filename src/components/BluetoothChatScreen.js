import React, { useState } from 'react';
import { View, StyleSheet, TouchableOpacity, Text, FlatList, TextInput, KeyboardAvoidingView, Platform } from 'react-native';

export default function BluetoothChatScreen({ messages, onSendMessage, onEndChat, peerName }) {
  const [msgText, setMsgText] = useState('');
  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>💬 دردشة بلوتوث — {peerName || 'الطرف الآخر'}</Text>
        <TouchableOpacity onPress={onEndChat}><Text style={styles.closeText}>إنهاء</Text></TouchableOpacity>
      </View>
      <Text style={styles.notice}>ملاحظة: البلوتوث قناة احتياطية للدردشة النصية فقط — لا يدعم مكالمات الفيديو.</Text>
      <FlatList
        data={messages}
        renderItem={({item}) => (
          <View style={[styles.bubble, item.sender === 'me' ? styles.myBubble : styles.remoteBubble]}>
            <Text style={{color: item.sender === 'me' ? 'white' : '#1A1F36'}}>{item.text}</Text>
          </View>
        )}
        keyExtractor={(_,i) => i.toString()}
        style={{flex: 1, margin: 10}}
      />
      <View style={styles.chatInput}>
        <TouchableOpacity onPress={() => { if(msgText.trim()) { onSendMessage(msgText); setMsgText(''); }}} style={styles.sendBtn}>
          <Text style={{color:'white', fontWeight:'600'}}>إرسال</Text>
        </TouchableOpacity>
        <TextInput value={msgText} onChangeText={setMsgText} placeholder="اكتب رسالة..." style={styles.input} placeholderTextColor="#8A94A6" />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F7F9FC' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#E1E6EF' },
  headerTitle: { fontSize: 16, fontWeight: '700', color: '#1A1F36' },
  closeText: { color: '#E0453F', fontWeight: '600' },
  notice: { fontSize: 12, color: '#8A94A6', textAlign: 'center', padding: 8 },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 14, marginVertical: 3 },
  myBubble: { alignSelf: 'flex-end', backgroundColor: '#5B8DEF' },
  remoteBubble: { alignSelf: 'flex-start', backgroundColor: '#E1E6EF' },
  chatInput: { flexDirection: 'row', padding: 10, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#E1E6EF' },
  input: { flex: 1, borderWidth: 1, borderColor: '#E1E6EF', borderRadius: 22, paddingHorizontal: 16, marginRight: 10, backgroundColor: '#F7F9FC' },
  sendBtn: { backgroundColor: '#5B8DEF', borderRadius: 22, paddingHorizontal: 20, justifyContent: 'center' },
});
