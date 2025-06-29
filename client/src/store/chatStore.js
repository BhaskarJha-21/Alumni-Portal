import { create } from "zustand"
import { io } from "socket.io-client"
import axios from "axios"
import toast from "react-hot-toast"

// Use Vite environment variables
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000/api"
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:5000"

// Import auth store to get current user
import { useAuthStore } from "./authStore"

const useChatStore = create((set, get) => ({
  socket: null,
  rooms: [],
  currentRoom: null,
  messages: [],
  onlineUsers: new Set(),
  loading: false,
  unreadCounts: {},
  typingUsers: {},
  messageStatus: {}, // Track message delivery/read status

  initializeSocket: () => {
    const token = localStorage.getItem("token")
    if (!token) return

    const socket = io(SOCKET_URL, {
      auth: { token },
    })

    socket.on("connect", () => {
      console.log("Connected to chat server")
      // Request the list of online users to sync state
      socket.emit("getOnlineUsers", (onlineUserIds) => {
        set({ onlineUsers: new Set(onlineUserIds) })
      })
    })

    socket.on("newMessage", (message) => {
      // If user is in the room, add message to state and mark as read
      if (get().currentRoom?._id === message.roomId) {
        set((state) => ({ messages: [...state.messages, message] }))
        get().markMessagesAsRead(message.roomId, [message._id])
      }

      // Show notification if not in current room
      const room = get().rooms.find(r => r._id === message.roomId)
      if (room && get().currentRoom?._id !== message.roomId) {
        const senderName = message.sender?.name || "Someone"
        const messagePreview = message.text || (message.mediaUrl ? "Shared media" : "New message")
        toast(`${senderName}: ${messagePreview}`, {
          duration: 4000,
          position: "top-right",
        })
      }
    })

    socket.on("roomUpdated", (updatedRoom) => {
      set((state) => {
        const currentUserId = useAuthStore.getState().user?.id;
        const newUnreadCounts = { ...state.unreadCounts };
        
        if (updatedRoom.unreadCounts && currentUserId) {
          const countForCurrentUser = updatedRoom.unreadCounts[currentUserId] || 0;
          newUnreadCounts[updatedRoom._id] = countForCurrentUser;
        }

        return {
          rooms: state.rooms.map((room) =>
            room._id === updatedRoom._id 
              ? { ...room, ...updatedRoom, unreadCount: newUnreadCounts[updatedRoom._id] } 
              : room
          ),
          unreadCounts: newUnreadCounts,
        };
      });
    })

    socket.on("messageRead", (data) => {
      set((state) => ({
        messageStatus: {
          ...state.messageStatus,
          [data.messageId]: "read",
        },
      }))
    })

    socket.on("messagesDelivered", (data) => {
      set((state) => {
        const newStatus = { ...state.messageStatus }
        data.messageIds.forEach(messageId => {
          newStatus[messageId] = "delivered"
        })
        return { messageStatus: newStatus }
      })
    })

    socket.on("userTyping", (data) => {
      set((state) => ({
        typingUsers: {
          ...state.typingUsers,
          [data.roomId]: data.isTyping
            ? [...(state.typingUsers[data.roomId] || []), data.userId]
            : (state.typingUsers[data.roomId] || []).filter(id => id !== data.userId),
        },
      }))
    })

    socket.on("userOnline", (userId) => {
      set((state) => ({
        onlineUsers: new Set([...state.onlineUsers, userId]),
      }))
    })

    socket.on("userOffline", (userId) => {
      set((state) => {
        const newOnlineUsers = new Set(state.onlineUsers)
        newOnlineUsers.delete(userId)
        return { onlineUsers: newOnlineUsers }
      })
    })

    socket.on("error", (error) => {
      toast.error(error.message || "Chat error occurred")
    })

    set({ socket })
  },

  disconnectSocket: () => {
    const { socket } = get()
    if (socket) {
      socket.disconnect()
      set({ socket: null, onlineUsers: new Set() })
    }
  },

  loadRooms: async () => {
    set({ loading: true })
    try {
      const response = await axios.get(`${API_URL}/chat/rooms`)
      const rooms = response.data.rooms
      // Initialize unreadCounts from room data
      const unreadCounts = {}
      rooms.forEach(room => {
        unreadCounts[room._id] = room.unreadCount || 0
      })
      set({ rooms, loading: false, unreadCounts })
    } catch (error) {
      set({ loading: false })
      toast.error("Failed to load chat rooms")
    }
  },

  createRoom: async (name, memberIds, isGroup = false) => {
    try {
      const response = await axios.post(`${API_URL}/chat/rooms`, {
        name,
        memberIds,
        isGroup,
      })

      const { room } = response.data

      set((state) => ({
        rooms: [room, ...state.rooms],
      }))

      return { success: true, room }
    } catch (error) {
      const message = error.response?.data?.message || "Failed to create chat room"
      toast.error(message)
      return { success: false }
    }
  },

  joinRoom: (roomId) => {
    const { socket, rooms, unreadCounts } = get()
    const room = rooms.find((r) => r._id === roomId)

    if (socket && room) {
      socket.emit("joinRoom", roomId)
      console.log(`joinRoom: resetting unread count for room ${roomId}`)
      set({ currentRoom: room, messages: [], unreadCounts: { ...unreadCounts, [roomId]: 0 } })
      get().loadMessages(roomId)
    }
  },

  leaveRoom: () => {
    const { socket, currentRoom } = get()

    if (socket && currentRoom) {
      socket.emit("leaveRoom", currentRoom._id)
      set({ currentRoom: null, messages: [] })
    }
  },

  loadMessages: async (roomId, page = 1) => {
    set({ loading: true })
    try {
      const response = await axios.get(`${API_URL}/chat/rooms/${roomId}/messages?page=${page}&limit=50`)
      const { messages } = response.data

      set((state) => ({
        messages: page === 1 ? messages : [...messages, ...state.messages],
        loading: false,
      }))

      // Mark messages as read when loading
      if (page === 1 && messages.length > 0) {
        // Get current user from auth store
        const currentUser = useAuthStore.getState().user
        
        const unreadMessageIds = messages
          .filter(msg => msg.sender._id !== currentUser?.id)
          .map(msg => msg._id)

        if (unreadMessageIds.length > 0) {
          get().markMessagesAsRead(roomId, unreadMessageIds)
        }
      }
    } catch (error) {
      set({ loading: false })
      toast.error("Failed to load messages")
    }
  },

  markMessagesAsRead: async (roomId, messageIds) => {
    const { socket } = get()
    if (socket && messageIds.length > 0) {
      try {
        await axios.post(`${API_URL}/chat/rooms/${roomId}/read`, { messageIds })
        socket.emit("markAsRead", { roomId, messageIds })
      } catch (error) {
        console.error("Failed to mark messages as read:", error)
      }
    }
  },

  sendMessage: async (text, mediaFile = null) => {
    const { socket, currentRoom } = get()

    if (!socket || !currentRoom) return

    try {
      if (mediaFile) {
        // Send message with media via HTTP
        const formData = new FormData()
        formData.append("text", text)
        formData.append("media", mediaFile)

        const response = await axios.post(`${API_URL}/chat/rooms/${currentRoom._id}/messages`, formData, {
          headers: {
            "Content-Type": "multipart/form-data",
          },
        })

        // Add message to local state immediately
        const message = response.data.message
        set((state) => ({
          messages: [...state.messages, message],
        }))
      } else {
        // Send text message via socket
        socket.emit("sendMessage", {
          roomId: currentRoom._id,
          text,
        })
      }

      return { success: true }
    } catch (error) {
      toast.error("Failed to send message")
      return { success: false }
    }
  },

  startTyping: (roomId) => {
    const { socket } = get()
    if (socket) {
      socket.emit("typingStart", roomId)
    }
  },

  stopTyping: (roomId) => {
    const { socket } = get()
    if (socket) {
      socket.emit("typingStop", roomId)
    }
  },

  addMembersToGroup: async (roomId, memberIds) => {
    try {
      const response = await axios.post(`${API_URL}/chat/rooms/${roomId}/members`, {
        memberIds,
      })

      const { room } = response.data

      set((state) => ({
        rooms: state.rooms.map((r) => (r._id === roomId ? room : r)),
      }))

      return { success: true, room }
    } catch (error) {
      const message = error.response?.data?.message || "Failed to add members"
      toast.error(message)
      return { success: false }
    }
  },

  leaveGroup: async (roomId) => {
    try {
      await axios.delete(`${API_URL}/chat/rooms/${roomId}/leave`)

      set((state) => ({
        rooms: state.rooms.filter((r) => r._id !== roomId),
      }))

      return { success: true }
    } catch (error) {
      const message = error.response?.data?.message || "Failed to leave group"
      toast.error(message)
      return { success: false }
    }
  },

  promoteToAdmin: async (roomId, userId) => {
    try {
      const response = await axios.post(`${API_URL}/chat/rooms/${roomId}/admins`, { userId })
      const { room } = response.data
      set(state => ({
        rooms: state.rooms.map(r => r._id === roomId ? room : r),
        currentRoom: state.currentRoom._id === roomId ? room : state.currentRoom,
      }))
      toast.success("User promoted to admin")
      return { success: true, room }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to promote user")
      return { success: false }
    }
  },

  removeMember: async (roomId, memberId) => {
    try {
      const response = await axios.delete(`${API_URL}/chat/rooms/${roomId}/members/${memberId}`)
      const { room } = response.data
      set(state => ({
        rooms: state.rooms.map(r => r._id === roomId ? room : r),
        currentRoom: state.currentRoom._id === roomId ? room : state.currentRoom,
      }))
      toast.success("Member removed from group")
      return { success: true, room }
    } catch (error) {
      toast.error(error.response?.data?.message || "Failed to remove member")
      return { success: false }
    }
  },

  getMessageStatus: (messageId) => {
    return get().messageStatus[messageId] || "sent"
  },

  getTypingUsers: (roomId) => {
    return get().typingUsers[roomId] || []
  },

  isUserOnline: (userId) => {
    return get().onlineUsers.has(userId)
  },
}))

export default useChatStore
