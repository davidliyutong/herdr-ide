package chat

import (
	"herdr-ide/internal/chatproto"
	"herdr-ide/internal/settings"
)

// The plugin's settings (section "chat"), each per machine: they bound
// what the machine's chat host runs and keeps (chatproto.HostSettings).
const (
	// SettingPermissionMode: the permission mode a new chat starts in
	// (chatproto.Modes); full only with SettingAllowFull.
	SettingPermissionMode = "chat.permissionMode"
	// SettingAllowFull: the machine's chats may give their agents full
	// access (chatproto.HostSettings.AllowFull). Off by default.
	SettingAllowFull = "chat.allowFullAccess"
	// SettingIdleStopMinutes: minutes an agent with nothing to do keeps
	// running.
	SettingIdleStopMinutes = "chat.idleStopMinutes"
	// SettingMaxLive: the most agents running at once on the machine.
	SettingMaxLive = "chat.maxLive"
	// SettingMaxChats: the most chats the machine keeps.
	SettingMaxChats = "chat.maxChats"
	// SettingRetentionDays: days a closed chat is kept.
	SettingRetentionDays = "chat.retentionDays"
	// SettingMaxTotalMB: the most megabytes of every chat's log.
	SettingMaxTotalMB = "chat.maxTotalMB"
	// SettingMaxChatMB: the most megabytes of one chat's log.
	SettingMaxChatMB = "chat.maxChatMB"
)

func number(key string, def, min, max, step float64, order int) settings.Def {
	lo, hi := settings.Range(min, max)
	return settings.Def{Key: key, Type: settings.TypeNumber, Default: def, Min: lo, Max: hi, Integer: true, Step: step,
		Scope: settings.ScopeMachine, Section: ID, Order: order}
}

// Settings is the plugin's settings module (internal/registry). The
// bounds are the chat host's (chatproto.HostSettings.Clamp).
var Settings = settings.Module{
	Sections: []settings.Section{{ID: ID, Order: 72, Plugin: ID}},
	Defs: []settings.Def{
		{Key: SettingPermissionMode, Type: settings.TypeEnum, Default: chatproto.ModeDefault, Enum: chatproto.Modes,
			Scope: settings.ScopeMachine, Section: ID, Order: 10},
		{Key: SettingAllowFull, Type: settings.TypeBool, Default: false, Scope: settings.ScopeMachine, Section: ID, Order: 15},
		number(SettingIdleStopMinutes, chatproto.IdleStopMinutesDefault, chatproto.IdleStopMinutesMin, chatproto.IdleStopMinutesMax, 5, 20),
		number(SettingMaxLive, chatproto.MaxLiveDefault, chatproto.MaxLiveMin, chatproto.MaxLiveMax, 1, 30),
		number(SettingMaxChats, chatproto.MaxChatsDefault, chatproto.MaxChatsMin, chatproto.MaxChatsMax, 50, 40),
		number(SettingRetentionDays, chatproto.RetentionDaysDefault, chatproto.RetentionDaysMin, chatproto.RetentionDaysMax, 1, 50),
		number(SettingMaxTotalMB, chatproto.MaxTotalMBDefault, chatproto.MaxTotalMBMin, chatproto.MaxTotalMBMax, 64, 60),
		number(SettingMaxChatMB, chatproto.MaxChatMBDefault, chatproto.MaxChatMBMin, chatproto.MaxChatMBMax, 8, 70),
	},
}

// HostSettings are machine m's settings for its chat host, clamped; a
// core without settings (nil) gives the defaults.
func HostSettings(st *settings.Store, m string) chatproto.HostSettings {
	if st == nil {
		return chatproto.DefaultHostSettings()
	}
	num := func(key string) int64 {
		v, _ := st.GetFor(key, m).(float64)
		return int64(v)
	}
	return chatproto.HostSettings{
		IdleStopMinutes: int(num(SettingIdleStopMinutes)),
		MaxLive:         int(num(SettingMaxLive)),
		MaxChats:        int(num(SettingMaxChats)),
		RetentionDays:   int(num(SettingRetentionDays)),
		MaxTotalBytes:   num(SettingMaxTotalMB) << 20,
		MaxChatBytes:    num(SettingMaxChatMB) << 20,
		DefaultMode:     st.String(SettingPermissionMode, m),
		AllowFull:       st.Bool(SettingAllowFull, m),
	}.Clamp()
}
