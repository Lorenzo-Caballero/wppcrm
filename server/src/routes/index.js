const express = require("express")

const router = express.Router()

router.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

router.use("/auth",      require("./auth.routes"))
router.use("/admin",     require("./admin.routes"))
router.use("/sessions",  require("./sessions.routes"))
router.use("/chats",     require("./chats.routes"))
router.use("/campaigns", require("./campaigns.routes"))
router.use("/status",    require("./status.routes"))
router.use("/media",     require("./media.routes"))

module.exports = router
