import express from "express";
import http from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { sendNotificationToUser } from "./lib/notificationService.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

const normalize = (url) => url?.replace(/\/$/, "");

const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL
      .split(",")
      .map((o) => normalize(o.trim()))
  : [
      "https://localhost",
      "http://localhost:3000",
      "http://192.168.31.74:3000",
      "https://agrogram-wheat.vercel.app",
      "capacitor://localhost",
      "agropeer://localhost",
    ];

// const allowedOrigins = "https://localhost" || "http://localhost:3000" ||  "http://192.168.31.74:3000" || "capacitor://localhost" || "agropeer://localhost";


// const io = new Server(server, {
//   transports: ["websocket", "polling"],
//   cors: {
//     origin: (origin, callback) => {
//       if (!origin) return callback(null, true);

//       const normalizedOrigin = normalize(origin);

//       if (allowedOrigins.includes(normalizedOrigin)) {
//         return callback(null, true);
//       }

//       console.log("❌ Blocked CORS origin:", origin);
//       callback(new Error("Not allowed by CORS"));
//     },
//     credentials: true,
//   },
// });

const io = new Server(server, {
  transports: ["websocket", "polling"],
  cors: {
    origin: true,
    credentials: true,
  },
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🧠 Multi-tab safe: Map<userId, Set<socketIds>>
const userSocketMap = new Map();

io.on("connection", (socket) => {
  console.log("✅ User connected:", socket.id);

  socket.on("findOrCreateConversation", async (payload, callback) => {
    const { user1_id, user2_id, product_id } = payload;

    try {
      // Find existing conversation between these two users (product-agnostic)
      // This ensures one conversation per user pair
      const orFilter =
        `and(user1_id.eq."${user1_id}",user2_id.eq."${user2_id}"),` +
        `and(user1_id.eq."${user2_id}",user2_id.eq."${user1_id}")`;

      const { data: existing, error: findErr } = await supabase
        .from("conversations")
        .select("*")
        .or(orFilter)
        .is("deleted_at", null)
        .order("last_message_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (findErr) throw findErr;

      if (existing) {
        console.log("🟢 Existing conversation found:", existing.id);
        // Update product_id if provided and different (for context)
        if (product_id && existing.product_id !== product_id) {
          await supabase
            .from("conversations")
            .update({ product_id })
            .eq("id", existing.id);
        }
        callback({ conversation_id: existing.id });
        return;
      }

      // Create new conversation (product_id is optional for context)
      const { data: created, error: createErr } = await supabase
        .from("conversations")
        .insert([{ user1_id, user2_id, product_id: product_id || null }])
        .select()
        .single();

      if (createErr) throw createErr;

      callback({ conversation_id: created.id });
    } catch (err) {
      console.error("❌ Error in findOrCreateConversation:", err);
      callback({ error: true });
    }
  });

  function markUserOnline(payload) {
    // Accept either (userId) or ({ userId }) so we don't set socket.userId to undefined
    const userId = typeof payload === "string" ? payload : payload?.userId;
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
      console.warn("[registerUser/user-online] Invalid or missing userId, skipping. Payload:", payload);
      return;
    }

    socket.userId = userId;

    const existing = userSocketMap.get(userId) || new Set();
    existing.add(socket.id);
    userSocketMap.set(userId, existing);

    console.log(`🟢 User ${userId} added socket: ${socket.id} (total: ${existing.size})`);

    // Only emit ONLINE when first socket connects
    if (existing.size === 1) {
      io.emit("online-status", {
        userId,
        online: true,
        last_seen: null
      });
    }
  }

  socket.on("registerUser", markUserOnline);
  socket.on("user-online", markUserOnline);

  socket.on("join_conversation", (conversation_id, callback) => {
    socket.join(conversation_id);
    console.log(`👥 ${socket.userId} joined room ${conversation_id}`);
    if (callback) callback({ joined: true });
  });



  const userActivity = new Map();
  socket.on("user:page", ({ userId, page }) => {
    if (!userActivity.has(userId)) {
      userActivity.set(userId, {});
    }
    userActivity.get(userId).page = page;
    console.log(`📍 User ${userId} is now on page →`, page);
  });

  socket.on("user:conversation", ({ userId, conversationId, active }) => {
    if (!userActivity.has(userId)) {
      userActivity.set(userId, {});
    }
    userActivity.get(userId).activeConversation = active ? conversationId : null;

    console.log(`📍 User ${userId} active conversation →`, active ? conversationId : "none");
  });






  // 💬 Send message
  socket.on("sendMessage", async (data) => {
    console.log("📨 Incoming message:", data);
    const { sender_id, conversation_id, content } = data;

    if (!sender_id || !conversation_id || !content) {
      console.log("⚠️ Missing message fields");
      return;
    }

    try {
      // 1️⃣ Save message in Supabase
      const { data: message, error: messageError } = await supabase
        .from("messages")
        .insert([{ conversation_id, sender_id, content }])
        .select()
        .single();

      if (messageError) throw messageError;

      // 2️⃣ Fetch conversation participants
      const { data: convo, error: convoError } = await supabase
        .from("conversations")
        .select("user1_id, user2_id")
        .eq("id", conversation_id)
        .single();

      if (convoError) throw convoError;

      const { user1_id, user2_id } = convo;

      // 3️⃣ Broadcast inside conversation (for active users in chat)
      io.to(conversation_id).emit("receiveMessage", message);

      // 4️⃣ Also send directly to both users (for sidebar updates)
      const recipientId = sender_id === user1_id ? user2_id : user1_id;
      const recipientSockets = userSocketMap.get(recipientId);

      if (recipientSockets && recipientId !== sender_id) {
        for (const sId of recipientSockets) {
          io.to(sId).emit("receiveMessage", message);
        }
      }
      // 5️⃣ Send push notification to recipient if they're not online
      if (recipientId && recipientId !== sender_id) {
        const recipientOnline = userSocketMap.has(recipientId);
        const activity = userActivity.get(recipientId) || {};

        const isInChatsPage = activity.page === "chats";
        const isReadingConversation = activity.activeConversation === conversation_id;

        const shouldSendNotification =
          !recipientOnline ||       // User offline
          !isInChatsPage ||         // User online but not on chats page
          !isReadingConversation;   // User online on chats page but NOT reading this conversation

        if (shouldSendNotification) {
          try {
            // Get sender info
            const { data: senderInfo } = await supabase
              .from("userinfo")
              .select("firstName, lastName")
              .eq("id", sender_id)
              .single();

            const senderName = senderInfo
              ? `${senderInfo.firstName || ""} ${senderInfo.lastName || ""}`.trim() || "Someone"
              : "Someone";

            // Check for product inquiry
            const { data: conversation } = await supabase
              .from("conversations")
              .select("product_id")
              .eq("id", conversation_id)
              .single();

            let notificationTitle = `New message from ${senderName}`;
            let notificationBody =
              content.length > 100 ? content.substring(0, 100) + "..." : content;

            if (conversation?.product_id) {
              const { data: product } = await supabase
                .from("agri_products")
                .select("title")
                .eq("id", conversation.product_id)
                .single();

              if (product) {
                notificationTitle = `New inquiry about ${product.title}`;
                notificationBody = `${senderName} sent a message`;
              }
            }

            // Send push notification (web + Android)
            await sendNotificationToUser(recipientId, {
              title: notificationTitle,
              body: notificationBody,
              data: {
                type: conversation?.product_id ? "product_inquiry" : "chat_message",
                conversationId: conversation_id,
                senderId: sender_id,
                messageId: message.id,
                productId: conversation?.product_id || null,
                url: `/chats?conversation=${conversation_id}`,
                platform: "all",
              },
            });

            console.log(`📱 Push notification sent to user ${recipientId}`);
          } catch (notifError) {
            console.error("❌ Error sending push notification:", notifError);
          }
        } else {
          // No notification because user is active in chat
          console.log(
            `🔕 No notification to ${recipientId}. Reason:`,
            recipientOnline
              ? isInChatsPage
                ? isReadingConversation
                  ? "User is reading this conversation"
                  : "User is on chats page but not reading this conversation"
                : "User is online but not on chats page"
              : "User offline"
          );
        }
      }
      console.log(`✅ Sent message to room ${conversation_id} and users`);
    } catch (err) {
      console.error("❌ Error saving message:", err);
    }
  });

  socket.on("markAsRead", async ({ conversation_id, reader_id }) => {
    try {
      // Update unread messages for this conversation
      const { data: updated, error } = await supabase
        .from("messages")
        .update({ read_at: new Date().toISOString() })
        .eq("conversation_id", conversation_id)
        .neq("sender_id", reader_id)
        .is("read_at", null)
        .select("id, sender_id");

      if (error) throw error;

      if (!updated?.length) {
        console.log("⚠️ No messages updated — maybe all already read");

        const { count: unreadCount, error: countError } = await supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .eq("conversation_id", conversation_id)
          .neq("sender_id", reader_id)
          .is("read_at", null);

        console.log("🧮 Unread count query result:", { unreadCount, countError });

        if (countError) {
          console.error("❌ Error fetching unread count:", countError);
        } else {
          console.log("✅ Unread count fetched successfully:", unreadCount);
        }

        io.to(conversation_id).emit("messagesSeen", {
          conversation_id,
          reader_id,
          seen_message_ids: [],
          unread_count: unreadCount ?? 0,
        });
        return;
      }

      console.log(`👀 ${reader_id} marked ${updated.length} messages as read`);

      const seen_message_ids = updated.map((m) => m.id);
      const senderIds = [...new Set(updated.map((m) => m.sender_id))];

      // 🧮 Get the remaining unread count
      const { count: unreadCount, error: countError } = await supabase
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("conversation_id", conversation_id)
        .neq("sender_id", reader_id)
        .is("read_at", null);

      if (countError) throw countError;

      // 🟢 Emit to everyone in the room
      console.log("📢 Emitting messagesSeen:", {
        conversation_id,
        reader_id,
        seen_message_ids,
        unreadCount,
      });

      io.to(conversation_id).emit("messagesSeen", {
        conversation_id,
        reader_id,
        seen_message_ids,
        unread_count: unreadCount ?? 0,
      });

      // 🟡 Also notify each sender directly (so they get seen status even if not in room)
      senderIds.forEach((sid) => {
        const sSockets = userSocketMap.get(sid);
        if (sSockets && sSockets.size) {
          for (const sId of sSockets) {
            console.log(`📤 Emitting messagesSeen directly to sender ${sid} at socket ${sId}`);
            io.to(sId).emit("messagesSeen", {
              conversation_id,
              reader_id,
              seen_message_ids,
              unread_count: unreadCount ?? 0,
            });
          }
        } else {
          console.log(`⚠️ Sender ${sid} not found in userSocketMap`);
        }
      });
    } catch (err) {
      console.error("❌ Error marking as read:", err);
    }
  });

  // 🔨 Clear conversation messages (soft delete messages by setting deleted_at)
  socket.on("clearConversation", async ({ conversation_id, user_id }, callback) => {
    console.log("[clearConversation] called", { conversation_id, user_id });
    if (!conversation_id || !user_id) {
      callback && callback({ error: true, message: "Missing conversation_id or user_id" });
      return;
    }
    try {
      // Validate conversation and permissions
      const { data: convo, error: convoErr } = await supabase
        .from("conversations")
        .select("user1_id, user2_id")
        .eq("id", conversation_id)
        .single();

      if (convoErr || !convo) {
        console.error("❌ Conversation not found for clearing:", convoErr);
        callback && callback({ error: true, message: "Conversation not found" });
        return;
      }

      const { user1_id, user2_id } = convo;
      if (user_id !== user1_id && user_id !== user2_id) {
        callback && callback({ error: true, message: "Unauthorized" });
        return;
      }

      const now = new Date().toISOString();
      const { data: updatedMsgs, error: updErr } = await supabase
        .from("messages")
        .update({ deleted_at: now })
        .eq("conversation_id", conversation_id)
        .select("id");

      if (updErr) {
        console.error("[clearConversation] DB update error:", updErr.message, updErr.details);
        throw updErr;
      }
      console.log("[clearConversation] DB updated messages count:", updatedMsgs?.length ?? 0);

      // Emit to the room so active clients clear UI
      io.to(conversation_id).emit("conversationCleared", {
        conversation_id,
        by_user_id: user_id,
        cleared_count: updatedMsgs?.length || 0,
      });

      // Also notify both participants directly (so sidebar updates even if not in room)
      [user1_id, user2_id].forEach((uid) => {
        const sockets = userSocketMap.get(uid);
        if (sockets && sockets.size) {
          for (const sId of sockets) {
            io.to(sId).emit("conversationCleared", {
              conversation_id,
              by_user_id: user_id,
              cleared_count: updatedMsgs?.length || 0,
            });
          }
        }
      });

      console.log("[clearConversation] success, clearedCount:", updatedMsgs?.length || 0);
      callback && callback({ success: true, clearedCount: updatedMsgs?.length || 0 });
    } catch (err) {
      console.error("[clearConversation] ❌ Error:", err);
      callback && callback({ error: true, message: "Internal error" });
    }
  });

  // 🗑️ Delete conversation (soft-delete conversation and messages)
  socket.on("deleteConversation", async ({ conversation_id, user_id }, callback) => {
    console.log("[deleteConversation] called", { conversation_id, user_id });
    if (!conversation_id || !user_id) {
      callback && callback({ error: true, message: "Missing conversation_id or user_id" });
      return;
    }
    try {
      // Validate conversation and permissions
      const { data: convo, error: convoErr } = await supabase
        .from("conversations")
        .select("id, user1_id, user2_id")
        .eq("id", conversation_id)
        .single();

      if (convoErr || !convo) {
        console.error("❌ Conversation not found for deletion:", convoErr);
        callback && callback({ error: true, message: "Conversation not found" });
        return;
      }

      const { user1_id, user2_id } = convo;
      const uid = user_id != null ? String(user_id) : null;
      const u1 = user1_id != null ? String(user1_id) : null;
      const u2 = user2_id != null ? String(user2_id) : null;
      if (!uid || (uid !== u1 && uid !== u2)) {
        callback && callback({ error: true, message: "Unauthorized" });
        return;
      }

      const now = new Date().toISOString();
      const { data: updatedConv, error: convErr } = await supabase
        .from("conversations")
        .update({ deleted_at: now })
        .eq("id", conversation_id)
        .select("id");

      if (convErr) {
        console.error("[deleteConversation] DB update conversations error:", convErr.message, convErr.details);
        throw convErr;
      }
      console.log("[deleteConversation] DB updated conversation:", updatedConv?.length ?? 0);

      // Soft-delete messages as well
      const { data: updatedMsgs, error: msgsErr } = await supabase
        .from("messages")
        .update({ deleted_at: now })
        .eq("conversation_id", conversation_id)
        .select("id");

      if (msgsErr) {
        console.error("[deleteConversation] DB update messages error:", msgsErr.message, msgsErr.details);
        throw msgsErr;
      }
      console.log("[deleteConversation] DB updated messages count:", updatedMsgs?.length ?? 0);

      // Emit to room and to both participants
      io.to(conversation_id).emit("conversationDeleted", {
        conversation_id,
        by_user_id: user_id,
      });

      [user1_id, user2_id].forEach((uid) => {
        const sockets = userSocketMap.get(uid);
        if (sockets && sockets.size) {
          for (const sId of sockets) {
            io.to(sId).emit("conversationDeleted", {
              conversation_id,
              by_user_id: user_id,
            });
          }
        }
      });

      console.log("[deleteConversation] success");
      callback && callback({ success: true });
    } catch (err) {
      console.error("[deleteConversation] ❌ Error:", err);
      callback && callback({ error: true, message: "Internal error" });
    }
  });

  socket.on("disconnect", () => {
    try {
      const userId = socket.userId;
      console.log("[disconnect] ---- DISCONNECT DEBUG ----");
      console.log("[disconnect] Socket ID:", socket.id, "User ID on socket:", userId);

      if (!userId) {
        console.log("[disconnect] No userId, skipping map cleanup");
        return;
      }

      // Map method is .get() — typo .git causes "ReferenceError: git is not defined"
      const set = userSocketMap.get(userId);
      if (!set) {
        console.log("[disconnect] No socket set for userId:", userId);
        return;
      }

      set.delete(socket.id);

      if (set.size === 0) {
        userSocketMap.delete(userId);
        io.emit("online-status", {
          userId,
          online: false,
          last_seen: new Date().toISOString(),
        });
        console.log("[disconnect] 🔴 User fully offline:", userId);
      } else {
        userSocketMap.set(userId, set);
        console.log("[disconnect] 🟡 User still online via other sockets:", [...set]);
      }
      console.log("[disconnect] --------------------------");
    } catch (err) {
      console.error("[disconnect] ❌ Error in disconnect handler:", err);
    }

  });



});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("[server] env check: NODE_ENV=", process.env.NODE_ENV, "FRONTEND_URL present:", !!process.env.FRONTEND_URL);
});
