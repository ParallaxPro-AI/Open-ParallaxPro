// RPG camera — third-person orbit camera with mouse look
class RPGCameraBehavior extends GameScript {
    _behaviorName = "camera_rpg"; _distance = 10; _height = 6; _lookHeight = 1.5; _smoothSpeed = 5; _sensitivity = 0.12;
    _yaw = 0; _pitch = 20; _camX = 0; _camY = 6; _camZ = 10;
    onStart() { var p=this.scene.findEntityByName("Hero");if(p){var pp=p.transform.position;this._camX=pp.x;this._camY=pp.y+this._height;this._camZ=pp.z+this._distance;} }
    onUpdate(dt) { var p=this.scene.findEntityByName("Hero");if(!p)return;
        var delta=this.input.getMouseDelta?this.input.getMouseDelta():{x:0,y:0};
        this._yaw+=delta.x*this._sensitivity;this._pitch=Math.max(-10,Math.min(60,this._pitch+delta.y*this._sensitivity));
        var pp=p.transform.position;var yawR=this._yaw*Math.PI/180;var pitchR=this._pitch*Math.PI/180;
        var tX=pp.x-Math.sin(yawR)*Math.cos(pitchR)*this._distance;
        var tY=pp.y+this._height+Math.sin(pitchR)*this._distance*0.5;
        var tZ=pp.z+Math.cos(yawR)*Math.cos(pitchR)*this._distance;
        var t=1-Math.exp(-this._smoothSpeed*dt);
        this._camX+=(tX-this._camX)*t;this._camY+=(tY-this._camY)*t;this._camZ+=(tZ-this._camZ)*t;
        this.scene.setPosition(this.entity.id,this._camX,this._camY,this._camZ);
        this.entity.transform.lookAt(pp.x,pp.y+this._lookHeight,pp.z);
        this.scene._tpYaw=this._yaw;
    }
}
