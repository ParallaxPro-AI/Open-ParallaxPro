// also: action-game, vehicle-switching, orbit-camera, hybrid-cam, aim-down-sights, over-the-shoulder
// Third-person camera — orbit with mouse on foot, chase camera in vehicles.
// Right-click switches to over-the-shoulder aim mode: camera pulls in
// closer + offsets to the player's right so the player sits in the
// bottom-left of the frame, and the crosshair HUD panel is shown. Other
// behaviors (pistol_combat) read scene._aiming + scene._tpPitch to fire
// along the camera forward instead of along the player's facing.
class ThirdPersonCameraBehavior extends GameScript {
    _behaviorName = "camera_third_person";
    _distance = 8;
    _height = 4;
    _lookHeight = 1.5;
    _smoothSpeed = 6;
    _sensitivity = 0.15;
    _aimDistance = 3.5;
    _aimHeight = 2.0;
    _aimShoulderOffset = 1.2;
    _aimSensitivity = 0.08;
    _aimToggleKey = "MouseRight";
    _crosshairPanel = "hud/crosshair";
    _yawDeg = 0;
    _pitchDeg = 15;
    _camX = 0;
    _camY = 4;
    _camZ = 8;
    _aiming = false;

    onStart() {
        var player = this.scene.findEntityByName("Player");
        if (player) {
            var pp = player.transform.position;
            this._camX = pp.x;
            this._camY = pp.y + this._height;
            this._camZ = pp.z + this._distance;
        }
    }

    onUpdate(dt) {
        var delta = this.input.getMouseDelta();

        // Aim toggle — right mouse held. Disabled in vehicles (you don't
        // get a foot-aim camera while driving).
        var nowAiming = !this.scene._inVehicle
            && this.input.isKeyDown && this.input.isKeyDown(this._aimToggleKey);
        if (nowAiming !== this._aiming) {
            this._aiming = nowAiming;
            this.scene._aiming = nowAiming;
            if (this.scene.events && this.scene.events.ui) {
                this.scene.events.ui.emit(nowAiming ? "show_ui" : "hide_ui",
                                          { panel: this._crosshairPanel });
            }
        }

        if (this.scene._inVehicle && this.scene._vehicleEntity) {
            this._updateVehicleCamera(dt, delta);
        } else if (this._aiming) {
            this._updateAimCamera(dt, delta);
        } else {
            this._updateOrbitCamera(dt, delta);
        }
    }

    _updateOrbitCamera(dt, delta) {
        this._yawDeg += delta.x * this._sensitivity;
        this._pitchDeg += delta.y * this._sensitivity;
        if (this._pitchDeg > 89) this._pitchDeg = 89;
        if (this._pitchDeg < -89) this._pitchDeg = -89;

        this.scene._tpYaw = this._yawDeg;
        this.scene._tpPitch = this._pitchDeg;

        var target = this.scene.findEntityByName("Player");
        if (!target) return;

        var tp = target.transform.position;
        var yawRad = this._yawDeg * Math.PI / 180;
        var pitchRad = this._pitchDeg * Math.PI / 180;

        var targetX = tp.x - Math.sin(yawRad) * Math.cos(pitchRad) * this._distance;
        var targetY = tp.y + this._height + Math.sin(pitchRad) * this._distance;
        var targetZ = tp.z + Math.cos(yawRad) * Math.cos(pitchRad) * this._distance;

        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);
        this.entity.transform.lookAt(tp.x, tp.y + this._lookHeight, tp.z);
    }

    _updateAimCamera(dt, delta) {
        // Lower sensitivity for aim precision.
        this._yawDeg += delta.x * this._aimSensitivity;
        this._pitchDeg += delta.y * this._aimSensitivity;
        if (this._pitchDeg > 75) this._pitchDeg = 75;
        if (this._pitchDeg < -75) this._pitchDeg = -75;

        this.scene._tpYaw = this._yawDeg;
        this.scene._tpPitch = this._pitchDeg;

        var target = this.scene.findEntityByName("Player");
        if (!target) return;

        var tp = target.transform.position;
        var yawRad = this._yawDeg * Math.PI / 180;
        var pitchRad = this._pitchDeg * Math.PI / 180;

        // Forward (engine convention: -Z forward at yaw=0, pitch>0 looks down)
        var fx = Math.sin(yawRad) * Math.cos(pitchRad);
        var fy = -Math.sin(pitchRad);
        var fz = -Math.cos(yawRad) * Math.cos(pitchRad);
        // Right vector (horizontal perpendicular to forward) — used to push
        // the camera off the player's right shoulder so the player frames
        // bottom-left.
        var rx = Math.cos(yawRad);
        var rz = Math.sin(yawRad);

        var targetX = tp.x - fx * this._aimDistance + rx * this._aimShoulderOffset;
        var targetY = tp.y + this._aimHeight - fy * this._aimDistance;
        var targetZ = tp.z - fz * this._aimDistance + rz * this._aimShoulderOffset;

        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);

        // Look along the forward ray rather than at the player so the
        // crosshair (screen center) maps to the world point we'd raycast
        // against. lookAt point is far enough that any drift in pitch math
        // doesn't matter.
        var lookDist = 50;
        this.entity.transform.lookAt(this._camX + fx * lookDist,
                                     this._camY + fy * lookDist,
                                     this._camZ + fz * lookDist);

        // Expose camera position + forward so weapons can do the standard
        // third-person-shooter trick: raycast FROM the camera through the
        // crosshair to find the aim point, then fire from the gun TOWARD
        // that point. Without this, bullets shoot in a parallel-but-offset
        // ray and miss whatever the crosshair is on.
        this.scene._camPos = { x: this._camX, y: this._camY, z: this._camZ };
        this.scene._camForward = { x: fx, y: fy, z: fz };
    }

    _updateVehicleCamera(dt, delta) {
        var vehicle = this.scene._vehicleEntity;
        var vp = vehicle.transform.position;
        var vehicleYaw = (this.scene._carYaw || 0) * Math.PI / 180;

        var vDist = this._distance * 1.4;
        var vHeight = this._height * 1.3;

        var targetX = vp.x - Math.sin(vehicleYaw) * vDist;
        var targetY = vp.y + vHeight;
        var targetZ = vp.z + Math.cos(vehicleYaw) * vDist;

        var t = 1 - Math.exp(-this._smoothSpeed * 0.7 * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);
        this.entity.transform.lookAt(vp.x, vp.y + 1.5, vp.z);

        this.scene._tpYaw = this.scene._carYaw || 0;
        this.scene._tpPitch = 0;
    }
}
